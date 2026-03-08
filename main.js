const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Tracks the user-selected library directory for IPC path boundary validation
let trustedLibraryPath = null;

/**
 * Checks that a resolved file path stays within the user's trusted library root.
 * Prevents IPC handlers from being used to read arbitrary files on the system.
 */
function isPathWithinLibrary(filePath) {
  if (!trustedLibraryPath) return true; // Library not yet set, allow (startup edge case)
  const resolved = path.resolve(filePath);
  const trustedRoot = path.resolve(trustedLibraryPath);
  return resolved.startsWith(trustedRoot + path.sep) || resolved === trustedRoot;
}

/**
 * Checks that an IPC event did NOT originate from a remote webview (e.g. YouTube Music).
 * Fails open: if frame info is absent or the URL is a local file, the call is allowed.
 * Only blocks when the sender is positively identified as an http/https remote frame.
 */
function isFromLocalFrame(event) {
  const url = event.senderFrame && event.senderFrame.url;
  // If no frame info is available, or it's a local file:// URL, allow the call.
  if (!url || url === '' || url.startsWith('file://')) return true;
  // Explicitly block remote origins (http/https webview frames like YouTube Music).
  if (url.startsWith('http://') || url.startsWith('https://')) return false;
  // Allow anything else (e.g. about:blank, chrome-extension, etc.)
  return true;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    frame: false,
    icon: path.join(__dirname, 'assets/icon_clean.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true
    },
    autoHideMenuBar: true,
    backgroundColor: '#0d0f14'
  });

  win.loadFile('index.html');

  // Strip CSP only for YouTube/YouTube Music requests so their service workers work.
  // All other responses (including our own app) keep their CSP intact.
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = Object.assign({}, details.responseHeaders);
    if (details.url.includes('music.youtube.com') || details.url.includes('youtube.com')) {
      delete responseHeaders['content-security-policy'];
      delete responseHeaders['Content-Security-Policy'];
    }
    callback({ cancel: false, responseHeaders });
  });

  // Restrict permissions: only allow 'media' (audio capture for WebRTC) from webviews.
  // Blocks webviews from prompting for camera, notifications, geolocation, etc.
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media'];
    callback(allowedPermissions.includes(permission));
  });

  // Start Sonos discovery only after window loads
  win.webContents.on('did-finish-load', () => {
    startSonosDiscovery(win);
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC handlers to let the renderer directly access the file system for local paths
ipcMain.handle('dialog:openDirectory', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  if (canceled) {
    return null;
  } else {
    return filePaths[0];
  }
});

const crypto = require('crypto');
const activeStreams = new Map();

// Generate a random ID for a local file path to prevent arbitrary file reading.
// Only accepts requests from the local renderer frame and paths within the trusted library.
ipcMain.handle('request-stream-id', (event, filePath) => {
  if (!isFromLocalFrame(event)) {
    console.warn('[Security] request-stream-id rejected: non-local frame origin');
    return null;
  }
  if (!isPathWithinLibrary(filePath)) {
    console.warn('[Security] request-stream-id rejected: path outside library boundary:', filePath);
    return null;
  }

  const streamId = crypto.randomUUID();
  activeStreams.set(streamId, filePath);

  // Prevent memory leaks by expiring the token after 24 hours
  setTimeout(() => activeStreams.delete(streamId), 24 * 60 * 60 * 1000);

  return streamId;
});

let expressApp;
let localServerUrl = '';

// Start a local express server to serve audio files to Sonos
function startLocalServer() {
  const express = require('express');
  const mime = require('mime-types');
  const http = require('http');
  const { WebSocketServer } = require('ws');
  const { PassThrough } = require('stream');
  const ffmpeg = require('fluent-ffmpeg');
  const ffmpegPath = require('ffmpeg-static');

  ffmpeg.setFfmpegPath(ffmpegPath);

  expressApp = express();
  const server = http.createServer(expressApp);

  // --- YouTube Music Live Transcoding Stream ---
  let ytWebmStream = null;
  let ytMp3Stream = null;
  let ffmpegCommand = null;
  let chunkCount = 0;

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    console.log('[Stream] YouTube Webview connected to websocket for audio stream');
    chunkCount = 0;

    if (ffmpegCommand) {
      ffmpegCommand.kill('SIGKILL');
    }

    ytWebmStream = new PassThrough();
    ytMp3Stream = new PassThrough();
    ytMp3Stream.setMaxListeners(0); // Allow multiple Sonos requests to listen

    ffmpegCommand = ffmpeg(ytWebmStream)
      .inputFormat('webm')
      .audioCodec('libmp3lame')
      .audioBitrate(256)
      .format('mp3')
      .on('start', (commandLine) => {
        console.log('[FFmpeg] Spawned Ffmpeg with command: ' + commandLine);
      })
      .on('error', (err) => {
        if (!err.message.includes('SIGKILL')) {
          console.error('[FFmpeg] Error:', err.message);
        }
      })
      .on('end', () => {
        console.log('[FFmpeg] Transcoding ended');
      });

    ffmpegCommand.pipe(ytMp3Stream);

    ws.on('message', (message) => {
      chunkCount++;
      if (chunkCount % 50 === 0) console.log(`[Stream] Received ${chunkCount} chunks from webview`);
      if (ytWebmStream) ytWebmStream.write(message);
    });

    ws.on('close', () => {
      console.log('[Stream] YouTube Webview disconnected from audio stream');
      if (ytWebmStream) ytWebmStream.end();
      if (ffmpegCommand) ffmpegCommand.kill('SIGKILL');
    });
  });

  // The live radio station endpoint for Sonos
  expressApp.get('/yt-stream.mp3', (req, res) => {
    console.log('[Express] Sonos requested /yt-stream.mp3');

    if (!ytMp3Stream) {
      console.log('[Express] Rejecting Sonos request: Stream not active (no webview connected)');
      return res.status(404).send('Stream not active');
    }

    if (chunkCount === 0) {
      console.log('[Express] Warning: Sonos requested stream before any WebM chunks arrived from Webview');
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');

    console.log('[Express] Piping FFmpeg MP3 output to Sonos HTTP response...');
    ytMp3Stream.pipe(res);

    req.on('close', () => {
      console.log('[Express] Sonos disconnected from /yt-stream.mp3');
    });
  });

  // Serve authorized local audio files via the UUID registry
  expressApp.get('/audio/:streamId', (req, res) => {
    try {
      // Remove any trailing extension used to fool Sonos UPnP
      const streamId = req.params.streamId.split('.')[0];
      const filePath = activeStreams.get(streamId);

      if (filePath && fs.existsSync(filePath)) {
        const mimeType = mime.lookup(filePath) || 'audio/mpeg';
        res.setHeader('Content-Type', mimeType);

        // Sonos also expects Content-Length and Accept-Ranges for seeking
        const stat = fs.statSync(filePath);
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Accept-Ranges', 'bytes');

        res.sendFile(filePath);
      } else {
        console.error('Sonos requested invalid or expired stream ID:', streamId);
        res.status(404).send('File not found or unauthorized');
      }
    } catch (e) {
      console.error('Error serving audio to Sonos:', e);
      res.status(500).send('Server Error');
    }
  });

  server.listen(0, '0.0.0.0', () => {
    const port = server.address().port;
    const ip = require('os').networkInterfaces();

    // Find local IP (avoid virtual interfaces)
    let localIp = '127.0.0.1';
    for (const name of Object.keys(ip)) {
      // Skip known virtual adapter names
      if (name.toLowerCase().includes('vbox') ||
        name.toLowerCase().includes('vmware') ||
        name.toLowerCase().includes('hyper-v') ||
        name.toLowerCase().includes('wsl') ||
        name.toLowerCase().includes('virbr') ||
        name.toLowerCase().includes('loopback')) {
        continue;
      }

      for (const net of ip[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          localIp = net.address;
          break;
        }
      }
      if (localIp !== '127.0.0.1') break;
    }

    localServerUrl = `http://${localIp}:${port}`;
    console.log(`Local audio server running at: ${localServerUrl}`);
  });
}

// Sonos Discovery
const dgram = require('dgram');
const { SonosDevice } = require('@svrooij/sonos');

function startSonosDiscovery(win) {
  console.log('Starting explicit-interface Sonos discovery...');

  // Find local IP (avoid virtual interfaces)
  const ip = require('os').networkInterfaces();
  let localIp = '127.0.0.1';
  for (const name of Object.keys(ip)) {
    if (name.toLowerCase().includes('vbox') ||
      name.toLowerCase().includes('vmware') ||
      name.toLowerCase().includes('hyper-v') ||
      name.toLowerCase().includes('wsl') ||
      name.toLowerCase().includes('virbr') ||
      name.toLowerCase().includes('loopback')) {
      continue;
    }
    for (const net of ip[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIp = net.address;
        break;
      }
    }
    if (localIp !== '127.0.0.1') break;
  }

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const discoveredDevices = [];

  socket.on('message', async (msg, rinfo) => {
    if (/.Sonos.+/.test(msg.toString())) {
      const host = rinfo.address;
      if (!discoveredDevices.some(d => d.host === host)) {
        try {
          const device = new SonosDevice(host);
          const desc = await device.GetDeviceDescription();
          // Push a placeholder first so we don't query the same device twice if messages stack up
          discoveredDevices.push({ host, name: desc.roomName });
          console.log(`Found Sonos Device: ${desc.roomName} at ${host}`);
          win.webContents.send('sonos:deviceList', discoveredDevices);
        } catch (e) {
          console.error(`Error querying Sonos at ${host}`, e.message);
        }
      }
    }
  });

  socket.on('listening', () => {
    try {
      socket.addMembership('239.255.255.250', localIp);
    } catch (e) {
      console.error('Failed to add multicast membership:', e.message);
    }
  });

  socket.bind(0, localIp, () => {
    const searchMsg = Buffer.from([
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 1',
      'ST: urn:schemas-upnp-org:device:ZonePlayer:1'
    ].join('\r\n'));

    // Broadcast on our specific adapter to bypass Windows routing bugs
    socket.send(searchMsg, 0, searchMsg.length, 1900, '255.255.255.255');
    socket.send(searchMsg, 0, searchMsg.length, 1900, '239.255.255.250');

    setTimeout(() => {
      console.log('Closing Sonos discovery socket.');
      socket.close();
    }, 10000); // Close socket after 10s of discovery
  });
}

const LIBRARY_FILE = path.join(app.getPath('userData'), 'library.json');

ipcMain.handle('scan-library', async (event, { dirPath, fastScan = false }) => {
  // Update the trusted library path whenever the user initiates a scan
  trustedLibraryPath = dirPath;
  try {
    const mm = await import('music-metadata');
    const audioFiles = [];
    let processedCount = 0;

    const existingLibrary = new Map();
    if (fastScan && fs.existsSync(LIBRARY_FILE)) {
      try {
        const data = fs.readFileSync(LIBRARY_FILE, 'utf8');
        const parsed = JSON.parse(data);
        parsed.forEach(track => {
          existingLibrary.set(track.path, track);
        });
      } catch (e) {
        console.error('Error load caching for fastScan:', e);
      }
    }

    async function scanDir(currentPath) {
      if (!fs.existsSync(currentPath)) return;
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          if (['.mp3', '.wav', '.ogg', '.flac', '.m4a'].includes(ext)) {
            if (fastScan && existingLibrary.has(fullPath)) {
              audioFiles.push(existingLibrary.get(fullPath));
            } else {
              try {
                // Parse ID3 tags
                const metadata = await mm.parseFile(fullPath);
                audioFiles.push({
                  name: entry.name,
                  path: fullPath,
                  title: metadata.common.title || entry.name,
                  artist: metadata.common.artist || 'Unknown Artist',
                  album: metadata.common.album || 'Unknown Album',
                  trackNo: metadata.common.track.no || null,
                  duration: metadata.format.duration || 0
                });
              } catch (err) {
                console.error(`Error parsing metadata for ${entry.name}:`, err.message);
                // Fallback if parsing fails
                audioFiles.push({
                  name: entry.name,
                  path: fullPath,
                  title: entry.name,
                  artist: 'Unknown Artist',
                  album: 'Unknown Album',
                  trackNo: null,
                  duration: 0
                });
              }
            } // Close the else block here

            processedCount++;
            if (processedCount % 50 === 0) {
              event.sender.send('scan-progress', { status: 'Scanning metadata...', count: processedCount });
            }
          }
        }
      }
    } // Close scanDir function

    event.sender.send('scan-progress', { status: 'Discovering files...', count: 0 });
    await scanDir(dirPath);

    // Cache the library to disk
    fs.writeFileSync(LIBRARY_FILE, JSON.stringify(audioFiles), 'utf8');
    return audioFiles;
  } catch (error) {
    console.error('Error scanning library:', error);
    return [];
  }
});

// Load the cached library on boot
ipcMain.handle('get-library', async () => {
  try {
    if (fs.existsSync(LIBRARY_FILE)) {
      const data = fs.readFileSync(LIBRARY_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Error reading library.json:', e);
  }
  return [];
});

// Extract album art on demand to prevent JSON caching bloat.
// Validates that the request comes from the local renderer and the path is within the library.
ipcMain.handle('get-album-art', async (event, filePath) => {
  if (!isFromLocalFrame(event)) {
    console.warn('[Security] get-album-art rejected: non-local frame origin');
    return null;
  }
  if (!isPathWithinLibrary(filePath)) {
    console.warn('[Security] get-album-art rejected: path outside library boundary:', filePath);
    return null;
  }
  try {
    if (!fs.existsSync(filePath)) return null;

    const mm = await import('music-metadata');
    // We only need the cover art, parsing duration isn't required
    const metadata = await mm.parseFile(filePath, { duration: false, skipCovers: false });
    const picture = metadata.common.picture && metadata.common.picture[0];
    if (picture) {
      return `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}`;
    }
  } catch (err) {
    console.error(`Error extracting album art on-demand for ${filePath}:`, err.message);
  }
  return null;
});

// Start Sonos Tracking
let activeSonosInterval = null;

function startSonosPolling(event, sonosPlayer) {
  if (activeSonosInterval) clearInterval(activeSonosInterval);

  activeSonosInterval = setInterval(async () => {
    try {
      const posInfo = await sonosPlayer.AVTransportService.GetPositionInfo();
      if (posInfo && posInfo.RelTime) {
        event.sender.send('sonos-progress', {
          current: posInfo.RelTime,
          total: posInfo.TrackDuration || "0:00:00"
        });
      }
    } catch (e) {
      // Stream unreadable or stopped, ignore
    }
  }, 1000);
}

// IPC handler to cast local file to Sonos
ipcMain.handle('sonos:play', async (event, { host, filePath }) => {
  try {
    const { SonosDevice } = require('@svrooij/sonos');
    const sonosPlayer = new SonosDevice(host);

    // Register this file for secure serving
    const streamId = crypto.randomUUID();
    activeStreams.set(streamId, filePath);
    setTimeout(() => activeStreams.delete(streamId), 24 * 60 * 60 * 1000);

    let extension = '.mp3';
    const match = filePath.match(/\.[0-9a-z]+$/i);
    if (match) extension = match[0];

    const trackUrl = `${localServerUrl}/audio/${streamId}${extension}`;

    console.log(`Playing on Sonos (${host}):`, trackUrl);

    const timeoutMsg = 'Connection timed out. Ensure the IP address is correct and the speaker is online.';
    await Promise.race([
      sonosPlayer.SetAVTransportURI(trackUrl).then(() => sonosPlayer.Play()),
      new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMsg)), 5000))
    ]);

    startSonosPolling(event, sonosPlayer);
    return { success: true };
  } catch (error) {
    console.error('Error calling Sonos:', error);
    return { success: false, error: error.message };
  }
});

// IPC handler to cast YouTube Music stream to Sonos
ipcMain.handle('sonos:playYt', async (event, { host }) => {
  try {
    const { SonosDevice } = require('@svrooij/sonos');
    const sonosPlayer = new SonosDevice(host);
    const trackUrl = `${localServerUrl}/yt-stream.mp3`;

    console.log(`Playing YouTube Stream on Sonos (${host}):`, trackUrl);

    const timeoutMsg = 'Connection timed out. Ensure the IP address is correct and the speaker is online.';
    await Promise.race([
      sonosPlayer.SetAVTransportURI(trackUrl).then(() => sonosPlayer.Play()),
      new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMsg)), 5000))
    ]);

    startSonosPolling(event, sonosPlayer);
    return { success: true };
  } catch (error) {
    console.error('Error calling Sonos for YT stream:', error);
    return { success: false, error: error.message };
  }
});

// IPC handler to pause/resume Sonos
ipcMain.handle('sonos:pause', async (event, { host, pause }) => {
  try {
    const { SonosDevice } = require('@svrooij/sonos');
    const sonosPlayer = new SonosDevice(host);
    if (pause) {
      await sonosPlayer.Pause();
    } else {
      await sonosPlayer.Play();
    }
    return { success: true };
  } catch (error) {
    console.error('Error pausing/resuming Sonos:', error);
    return { success: false, error: error.message };
  }
});

// IPC handler to set Sonos Volume
ipcMain.handle('sonos:setVolume', async (event, { host, volume }) => {
  try {
    const { SonosDevice } = require('@svrooij/sonos');
    const sonosPlayer = new SonosDevice(host);
    await sonosPlayer.SetVolume(volume);
    return { success: true };
  } catch (error) {
    console.error('Error setting Sonos volume:', error);
    return { success: false, error: error.message };
  }
});

// IPC handler to get Sonos State (Volume + Playback)
ipcMain.handle('sonos:getState', async (event, { host }) => {
  try {
    const { SonosDevice } = require('@svrooij/sonos');
    const sonosPlayer = new SonosDevice(host);

    // We can fetch CurrentState from GetTransportInfo and Volume from GetVolume
    const transportInfo = await sonosPlayer.AVTransportService.GetTransportInfo();
    const volumeInfo = await sonosPlayer.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' });
    const positionInfo = await sonosPlayer.AVTransportService.GetPositionInfo();

    // PLAYING, PAUSED_PLAYBACK, STOPPED, etc.
    const isPlaying = transportInfo.CurrentTransportState === 'PLAYING' || transportInfo.CurrentTransportState === 'TRANSITIONING';

    if (isPlaying) {
      startSonosPolling(event, sonosPlayer);
    }

    let trackMeta = positionInfo.TrackMetaData;
    // Map svrooij/sonos TrackMetaData (which has PascalCase) to our internal camelCase
    let mappedTrack = null;
    if (trackMeta && typeof trackMeta !== 'string') {
      mappedTrack = {
        title: trackMeta.Title || 'Unknown Title',
        artist: trackMeta.Artist || 'Unknown Artist',
        album: trackMeta.Album || 'Unknown Album'
      };
    }

    return {
      success: true,
      isPlaying,
      volume: volumeInfo.CurrentVolume,
      current: positionInfo.RelTime,
      total: positionInfo.TrackDuration,
      track: mappedTrack
    };
  } catch (error) {
    console.error('Error getting Sonos state:', error);
    return { success: false, error: error.message };
  }
});

// Allow renderer to fetch the server URL for websocket connection
ipcMain.handle('get-server-url', () => {
  return localServerUrl;
});

// Fetch desktop audio source ID for WebRTC capture
ipcMain.handle('get-desktop-audio-id', async () => {
  const { desktopCapturer } = require('electron');
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    for (const source of sources) {
      if (source.name.includes('Entire Screen') || source.name.includes('Screen 1') || source.id.startsWith('screen')) {
        console.log('Using Desktop Audio Source ID:', source.id);
        return source.id;
      }
    }
    // Fallback if none perfectly matched
    if (sources.length > 0) return sources[0].id;
  } catch (err) {
    console.error('Error fetching desktop sources:', err);
  }
  return null;
});

// Return the app version from package.json
ipcMain.handle('get-app-version', () => app.getVersion());

// Window control IPC handlers for the custom title bar
ipcMain.on('window:minimize', (event) => { BrowserWindow.fromWebContents(event.sender).minimize(); });
ipcMain.on('window:maximize', (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.on('window:close', (event) => { BrowserWindow.fromWebContents(event.sender).close(); });

// Start local server when app is ready
app.whenReady().then(() => {
  startLocalServer();
});
