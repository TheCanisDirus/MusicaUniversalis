const audio = new Audio();
let masterLibrary = [];
let activeTrackList = []; // The list shown in the main view
let playbackQueue = [];   // The list currently playing
let userPlaylists = JSON.parse(localStorage.getItem('userPlaylists')) || [];
let activePlaylistId = null; // null = Local Library
let currentIndex = -1; // Index within playbackQueue
let trackSortDirection = 1;

// -- Custom Title Bar Controls --
if (window.electronAPI) {
    document.getElementById('titlebar-min')?.addEventListener('click', () => window.electronAPI.minimizeWindow());
    document.getElementById('titlebar-max')?.addEventListener('click', () => window.electronAPI.maximizeWindow());
    document.getElementById('titlebar-close')?.addEventListener('click', () => window.electronAPI.closeWindow());
}

// Elements
const navLocal = document.getElementById('nav-local');
const viewLocal = document.getElementById('view-local');
const playerBar = document.getElementById('local-player-bar');

const playPauseBtn = document.getElementById('play-pause-btn');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');

const addDirBtn = document.getElementById('add-dir-btn');
const quickScanBtn = document.getElementById('quick-scan-btn');
const deepScanBtn = document.getElementById('deep-scan-btn');
const clearPlBtn = document.getElementById('clear-pl-btn');
const playlistEl = document.getElementById('playlist');

const scanProgressOverlay = document.getElementById('scan-progress-overlay');
const scanProgressText = document.getElementById('scan-progress-text');

function updateLibraryStats() {
    const trackCount = masterLibrary.length;
    const albumSet = new Set();
    const artistSet = new Set();
    masterLibrary.forEach(t => {
        if (t.album && t.album !== 'Unknown Album') albumSet.add(t.album);
        if (t.artist && t.artist !== 'Unknown Artist') artistSet.add(t.artist);
    });
    const vTracks = document.getElementById('stat-tracks');
    const vAlbums = document.getElementById('stat-albums');
    const vArtists = document.getElementById('stat-artists');
    if (vTracks) vTracks.textContent = trackCount;
    if (vAlbums) vAlbums.textContent = albumSet.size;
    if (vArtists) vArtists.textContent = artistSet.size;
}

// -- Settings & Theme Logic --
const settingsBtn = document.getElementById('settings-btn');
const settingsSidebar = document.getElementById('settings-sidebar');
const settingsOverlay = document.getElementById('settings-overlay');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const themeSelect = document.getElementById('theme-select');
const scaleSlider = document.getElementById('scale-slider');
const scaleValue = document.getElementById('scale-value');

// -- Now Playing Queue --
const queueBtn = document.getElementById('queue-btn');
const queuePanel = document.getElementById('queue-panel');
const queueOverlay = document.getElementById('queue-overlay');
const closeQueueBtn = document.getElementById('close-queue-btn');
const queueTrackList = document.getElementById('queue-track-list');
const queueSaveName = document.getElementById('queue-save-name');
const queueSaveBtn = document.getElementById('queue-save-btn');

function openSettings() {
    closeQueue(); // Ensure queue is closed
    settingsOverlay.classList.add('active');
    settingsSidebar.classList.add('active');
}

function closeSettings() {
    settingsOverlay.classList.remove('active');
    settingsSidebar.classList.remove('active');
}

settingsBtn.addEventListener('click', openSettings);
closeSettingsBtn.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

// Populate the app version label in the settings panel
if (window.electronAPI && window.electronAPI.getAppVersion) {
    window.electronAPI.getAppVersion().then(version => {
        const el = document.getElementById('app-version-label');
        if (el) el.textContent = `v${version}`;
    });
}

let currentScale = localStorage.getItem('appScale') || 100;
scaleSlider.value = currentScale;
scaleValue.textContent = `${currentScale}%`;

if (window.electronAPI && window.electronAPI.setZoomFactor) {
    window.electronAPI.setZoomFactor(currentScale / 100);
} else {
    document.body.style.zoom = currentScale / 100; // fallback but not ideal
}

// Hardware-accelerated live preview during drag
scaleSlider.addEventListener('input', (e) => {
    const newScale = e.target.value;
    scaleValue.textContent = `${newScale}%`;

    // Scale visually relative to the already painted layout scale
    const previewScale = newScale / currentScale;
    document.body.style.transformOrigin = 'top left';
    document.body.style.transform = `scale(${previewScale})`;
    document.body.style.willChange = 'transform';
});

// Permanent layout recalculation on release
scaleSlider.addEventListener('change', (e) => {
    const newScale = e.target.value;
    currentScale = newScale;

    // Remove the temporary proxy
    document.body.style.transform = 'none';
    document.body.style.willChange = 'auto';

    // Request actual layout repaint
    if (window.electronAPI && window.electronAPI.setZoomFactor) {
        window.electronAPI.setZoomFactor(newScale / 100);
    } else {
        document.body.style.zoom = newScale / 100; // fallback
    }

    localStorage.setItem('appScale', newScale);
});

const brandIconImg = document.querySelector('.brand-icon');
const currentTheme = localStorage.getItem('appTheme') || 'dark';

const THEME_ICONS = {
    dark: 'assets/icon_clean.png',
    light: 'assets/icon_light.png',
    volcanic: 'assets/icon_volcanic.png'
};

function applyTheme(theme) {
    document.body.classList.remove('light-theme', 'volcanic-theme');
    if (theme === 'light') document.body.classList.add('light-theme');
    if (theme === 'volcanic') document.body.classList.add('volcanic-theme');
    if (brandIconImg) brandIconImg.src = THEME_ICONS[theme] || THEME_ICONS.dark;
    themeSelect.value = theme;
}

applyTheme(currentTheme);

themeSelect.addEventListener('change', (e) => {
    const newTheme = e.target.value;
    applyTheme(newTheme);
    localStorage.setItem('appTheme', newTheme);
});

let currentLibraryPath = localStorage.getItem('libraryPath');
if (currentLibraryPath) {
    document.getElementById('add-dir-btn').title = "Current: " + currentLibraryPath;
}



if (window.electronAPI && window.electronAPI.onScanProgress) {
    window.electronAPI.onScanProgress((event, data) => {
        scanProgressOverlay.style.display = 'flex';
        scanProgressText.textContent = `${data.status} (${data.count})`;
    });
}

const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');
const trackNameDisplay = document.getElementById('track-name');
const seekBar = document.getElementById('seek-bar');
const volumeBar = document.getElementById('volume-bar');
const deviceSelect = document.getElementById('device-select');
let localDeviceName = 'Local Speakers';

navigator.mediaDevices.enumerateDevices().then(devices => {
    const outputs = devices.filter(d => d.kind === 'audiooutput');
    // Try to find the hardware device that corresponds to the default output, 
    // or just the first named output we can find.
    const defaultOut = outputs.find(d => d.deviceId === 'default');
    const hardwareOut = outputs.find(d => d.groupId === defaultOut?.groupId && d.deviceId !== 'default') || outputs.find(d => d.label && d.deviceId !== 'default') || outputs[0];

    if (hardwareOut && hardwareOut.label) {
        // e.g. "Speakers (Sound Blaster AE-9)" -> clean it up if needed, or just use as is
        // We will just use it directly.
        let cleanName = hardwareOut.label;
        if (cleanName.startsWith('Default - ')) cleanName = cleanName.replace('Default - ', '');

        localDeviceName = `Local Speakers (${cleanName})`;
        const localOpt = deviceSelect.querySelector('option[value="local"]');
        if (localOpt) localOpt.textContent = localDeviceName;
    }
}).catch(err => console.error("Failed to fetch audio devices:", err));
const searchInput = document.getElementById('library-search');

const trackSortBtn = document.getElementById('track-sort-btn');
if (trackSortBtn) {
    trackSortBtn.addEventListener('click', () => {
        trackSortDirection = trackSortDirection === 1 ? -1 : 1;
        trackSortBtn.textContent = trackSortDirection === 1 ? 'Track ↓' : 'Track ↑';
        renderPlaylist(searchInput ? searchInput.value : '');
    });
}
const albumArtImg = document.getElementById('album-art-img');

const artistListEl = document.getElementById('artist-list');
const albumListEl = document.getElementById('album-list');

// Winamp Panes State
let selectedArtistFilter = null;
let selectedAlbumFilter = null;

// -- Dynamic YouTube Profiles Setup --
const addProfileBtn = document.getElementById('add-profile-btn');
const ytProfilesList = document.getElementById('main-nav-list');
const dynamicViewsContainer = document.getElementById('dynamic-views-container');

// -- Context Menu Elements --
const profileContextMenu = document.getElementById('profile-context-menu');
const contextRename = document.getElementById('context-rename');
const contextDelete = document.getElementById('context-delete');

// -- Context Menu Elements (Playlists) --
const trackContextMenu = document.getElementById('track-context-menu');
const playlistContextMenu = document.getElementById('playlist-context-menu');
const plContextRename = document.getElementById('pl-context-rename');
const plContextDelete = document.getElementById('pl-context-delete');

const playlistNavList = document.getElementById('playlist-nav-list');
const addPlaylistBtn = document.getElementById('add-playlist-btn');

let rightClickedProfileId = null;
let rightClickedProfileLi = null;

let rightClickedTrackOriginalIndex = null;
let rightClickedPlaylistId = null;
let rightClickedPlaylistLi = null;

// Multi-select state for the track list
let selectedTrackPaths = new Set();
let lastClickedVisualIdx = -1;

// Hide context menu when clicking anywhere else
document.addEventListener('click', () => {
    profileContextMenu.style.display = 'none';
});

// Context Menu Action: Rename
contextRename.addEventListener('click', () => {
    if (rightClickedProfileLi) {
        rightClickedProfileLi.contentEditable = "true";
        rightClickedProfileLi.focus();

        // Highlight text
        const range = document.createRange();
        range.selectNodeContents(rightClickedProfileLi);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
});

// Context Menu Action: Delete
contextDelete.addEventListener('click', () => {
    if (rightClickedProfileId) {
        if (confirm("Are you sure you want to delete this profile?")) {
            // Remove from array
            ytProfiles = ytProfiles.filter(p => p.id !== rightClickedProfileId);
            saveProfiles();

            // Remove webview container and destroy it
            const wvContainer = document.getElementById(`view-${rightClickedProfileId}`);
            if (wvContainer) wvContainer.remove();

            if (activeWebviews[rightClickedProfileId]) {
                delete activeWebviews[rightClickedProfileId];
            }

            // Re-render
            renderProfiles();

            // If it was the active view being deleted, fall back to Local
            if (document.querySelectorAll('.dt-webview-container.active-view').length === 0) {
                deactivateAllViews();
                navLocal.classList.add('active');
                viewLocal.classList.add('active-view');
                playerBar.classList.remove('hidden');
            }
        }
    }
});

// Load profiles from storage
let ytProfiles = JSON.parse(localStorage.getItem('ytProfiles')) || [];
const activeWebviews = {}; // map of profileId -> webview element

function saveProfiles() {
    localStorage.setItem('ytProfiles', JSON.stringify(ytProfiles));
}

function deactivateAllViews() {
    navLocal.classList.remove('active');
    viewLocal.classList.remove('active-view');
    const drawer = document.getElementById('local-stats-drawer');
    if (drawer) drawer.classList.remove('active');

    document.querySelectorAll('.profile-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.dt-webview-container').forEach(el => el.classList.remove('active-view'));

    // Mute all background webviews
    Object.values(activeWebviews).forEach(wv => {
        wv.executeJavaScript(`if(window.setYtOutput) window.setYtOutput("muted"); undefined;`).catch(console.error);
    });
}

// Navigation Logic for Local Library
navLocal.addEventListener('click', () => {
    const drawer = document.getElementById('local-stats-drawer');
    if (navLocal.classList.contains('active')) {
        if (drawer) drawer.classList.toggle('active');
        return;
    }

    deactivateAllViews();
    navLocal.classList.add('active');
    viewLocal.classList.add('active-view');
    playerBar.classList.remove('hidden');
    if (drawer) drawer.classList.add('active');

    // If Sonos is selected, we might want to auto-push the paused local track,
    // but usually user just clicks play. So we do nothing special here.
});

// format time MM:SS
function formatTime(seconds) {
    if (isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// Update UI
audio.addEventListener('timeupdate', () => {
    timeCurrent.textContent = formatTime(audio.currentTime);
    if (audio.duration) {
        seekBar.value = (audio.currentTime / audio.duration) * 100;
    }
});

audio.addEventListener('loadedmetadata', () => {
    timeTotal.textContent = formatTime(audio.duration);
});

audio.addEventListener('ended', () => {
    playNext();
});

let isSonosPlaying = false;

function setPlayPauseUI(playing) {
    if (playing) {
        iconPlay.style.display = 'none';
        iconPause.style.display = 'block';
    } else {
        iconPlay.style.display = 'block';
        iconPause.style.display = 'none';
    }
}

audio.addEventListener('play', () => {
    if (getActualSelectedDevice() === 'local') setPlayPauseUI(true);
});

audio.addEventListener('pause', () => {
    if (getActualSelectedDevice() === 'local') setPlayPauseUI(false);
});

seekBar.addEventListener('input', () => {
    if (audio.duration) {
        audio.currentTime = (seekBar.value / 100) * audio.duration;
    }
});

volumeBar.addEventListener('input', () => {
    const vol = volumeBar.value;
    audio.volume = vol / 100; // Always sync UI with local internal volume too

    const selectedDevice = getActualSelectedDevice();
    if (selectedDevice && selectedDevice !== 'local') {
        if (window.electronAPI && window.electronAPI.setSonosVolume) {
            window.electronAPI.setSonosVolume(selectedDevice, parseInt(vol, 10));
        }
    }
});

volumeBar.addEventListener('wheel', (e) => {
    // Prevent default scroll behavior
    e.preventDefault();

    // deltaY < 0 means scrolled up, deltaY > 0 means scrolled down.
    // We adjust by steps of 5 points.
    let step = 5;
    let newVolume = parseInt(volumeBar.value, 10) - Math.sign(e.deltaY) * step;

    // Clamp between 0 and 100
    newVolume = Math.max(0, Math.min(100, newVolume));

    // Apply and dispatch an input event so Sonos sync logic is triggered
    if (parseInt(volumeBar.value, 10) !== newVolume) {
        volumeBar.value = newVolume;
        volumeBar.dispatchEvent(new Event('input'));
    }
}, { passive: false });

function togglePlayPause() {
    if (activeTrackList.length === 0) return;
    const selectedDevice = getActualSelectedDevice();

    if (selectedDevice === 'local') {
        if (audio.paused) {
            if (currentIndex === -1 && activeTrackList.length > 0) {
                playbackQueue = [...filteredPlaylist]; // Snapshot current view
                loadTrack(0);
            } else {
                audio.play();
            }
        } else {
            audio.pause();
        }
    } else {
        // Sonos Control
        if (currentIndex === -1 && activeTrackList.length > 0) {
            playbackQueue = [...filteredPlaylist];
            loadTrack(0);
        } else {
            isSonosPlaying = !isSonosPlaying;
            setPlayPauseUI(isSonosPlaying);
            if (window.electronAPI && window.electronAPI.pauseSonos) {
                window.electronAPI.pauseSonos(selectedDevice, !isSonosPlaying).catch(err => console.error(err));
            }
        }
    }
}

playPauseBtn.addEventListener('click', togglePlayPause);
nextBtn.addEventListener('click', playNext);
prevBtn.addEventListener('click', playPrev);

async function loadTrack(index) {
    if (index < 0 || index >= playbackQueue.length) return;
    currentIndex = index;
    const track = playbackQueue[currentIndex];

    trackNameDisplay.textContent = track.title || track.name;
    renderPlaylist();
    if (queuePanel.classList.contains('open')) renderQueue(); // Update queue highlight dynamically

    if (window.electronAPI && window.electronAPI.getAlbumArt) {
        albumArtImg.style.display = 'none';
        const b64 = await window.electronAPI.getAlbumArt(track.path);
        // Only show if we didn't skip to another song while loading
        if (b64 && currentIndex === index) {
            albumArtImg.src = b64;
            albumArtImg.style.display = 'block';
        }
    }

    let selectedDevice = deviceSelect.value;

    if (selectedDevice === 'local') {
        const fileUrl = track.path.replace(/\\/g, '/');
        audio.src = `file:///${encodeURI(fileUrl)}`;
        audio.play();
    } else {
        // Stop local playback
        audio.pause();
        audio.src = '';

        // Address manual IP
        if (selectedDevice === 'manual_sonos') {
            const manualIp = document.getElementById('manual-sonos-ip').value.trim();
            if (!manualIp) {
                alert("Please enter a valid Sonos IP address.");
                return;
            }
            selectedDevice = manualIp;
        }

        // Send to Sonos
        if (window.electronAPI) {
            window.electronAPI.playOnSonos(selectedDevice, track.path)
                .then(res => {
                    if (!res.success) {
                        console.error("Sonos error:", res.error);
                        alert("Failed to play on Sonos: " + res.error);
                    } else {
                        isSonosPlaying = true;
                        setPlayPauseUI(true);
                    }
                });
        }
    }
}

// Listen for discovered Sonos devices
if (window.electronAPI && window.electronAPI.onSonosDevices) {
    window.electronAPI.onSonosDevices((event, devices) => {
        // Maintain the local and manual option
        let optionsHtml = `<option value="local">${localDeviceName}</option><option value="manual_sonos">Manual Sonos IP...</option>`;
        devices.forEach(device => {
            optionsHtml += `<option value="${device.host}">Sonos: ${device.name}</option>`;
        });

        const currentSelection = deviceSelect.value;
        deviceSelect.innerHTML = optionsHtml;

        // Attempt to restore previous selection if it still exists
        if (Array.from(deviceSelect.options).some(opt => opt.value === currentSelection)) {
            deviceSelect.value = currentSelection;
        }
    });
}

function getActualSelectedDevice() {
    let selectedDevice = deviceSelect.value;
    if (selectedDevice === 'manual_sonos') {
        const manualIp = document.getElementById('manual-sonos-ip').value.trim();
        if (!manualIp) {
            alert("Please enter a valid Sonos IP address.");
            return null;
        }
        selectedDevice = manualIp;
    }
    return selectedDevice;
}

// When device is changed manually, switch playback and show/hide manual IP input
deviceSelect.addEventListener('change', () => {
    const manualIpInput = document.getElementById('manual-sonos-ip');
    if (deviceSelect.value === 'manual_sonos') {
        manualIpInput.style.display = 'block';
    } else {
        manualIpInput.style.display = 'none';
    }

    const selectedDevice = getActualSelectedDevice();
    if (!selectedDevice) return;

    if (selectedDevice !== 'local' && window.electronAPI && window.electronAPI.getSonosState) {
        window.electronAPI.getSonosState(selectedDevice).then(state => {
            if (state.success) {
                isSonosPlaying = state.isPlaying;
                setPlayPauseUI(isSonosPlaying);
                if (state.volume !== undefined) {
                    volumeBar.value = state.volume;
                }
                if (state.track) {
                    const title = state.track.title || 'Unknown Track';
                    const artist = state.track.artist || 'Unknown Artist';
                    trackNameDisplay.textContent = `${title} - ${artist}`;
                }
                if (state.current && state.total) {
                    const currentSec = timeStringToSeconds(state.current);
                    const totalSec = timeStringToSeconds(state.total);
                    timeCurrent.textContent = formatTime(currentSec);
                    timeTotal.textContent = formatTime(totalSec);
                    if (totalSec > 0) {
                        seekBar.max = totalSec;
                        seekBar.value = currentSec;
                    }
                }
            }
        });
    } else if (selectedDevice === 'local') {
        setPlayPauseUI(!audio.paused);
        volumeBar.value = audio.volume * 100;
    }

    // Check if we are currently on ANY YouTube Music tab
    const activeYtContainer = document.querySelector('.dt-webview-container.active-view');

    if (activeYtContainer) {
        // Find the specific webview inside this container
        const activeWebview = activeYtContainer.querySelector('webview');
        if (!activeWebview) return;

        if (selectedDevice !== 'local') {
            // Mute local YT playback and send stream to Sonos
            activeWebview.executeJavaScript(`if(window.setYtOutput) window.setYtOutput("sonos"); undefined;`);
            window.electronAPI.playYtOnSonos(selectedDevice)
                .then(res => {
                    if (!res.success) {
                        console.error('Sonos YT error:', res.error);
                        alert("Failed to stream YouTube to Sonos: " + res.error);
                    } else {
                        isSonosPlaying = true;
                        setPlayPauseUI(true);
                    }
                });
        } else {
            // Unmute local YT playback
            activeWebview.executeJavaScript(`if(window.setYtOutput) window.setYtOutput("local"); undefined;`);
        }
    } else {
        if (currentIndex !== -1) {
            loadTrack(currentIndex);
        }
    }
});

function playNext() {
    if (playbackQueue.length === 0) return;
    let nextIndex = currentIndex + 1;
    if (nextIndex >= playbackQueue.length) nextIndex = 0;
    loadTrack(nextIndex);
}

function playPrev() {
    if (playbackQueue.length === 0) return;
    let prevIndex = currentIndex - 1;
    if (prevIndex < 0) prevIndex = playbackQueue.length - 1;
    loadTrack(prevIndex);
}

addDirBtn.addEventListener('click', async () => {
    if (window.electronAPI) {
        const dirPath = await window.electronAPI.selectLibrary();
        if (dirPath) {
            playlistEl.innerHTML = '<li class="empty-state">Scanning library... This may take a moment.</li>';
            scanProgressOverlay.style.display = 'flex';
            const audioFiles = await window.electronAPI.scanLibrary({ dirPath, fastScan: false });
            scanProgressOverlay.style.display = 'none';

            if (audioFiles && audioFiles.length > 0) {
                localStorage.setItem('libraryPath', dirPath);
                currentLibraryPath = dirPath;

                masterLibrary = audioFiles;
                activeTrackList = masterLibrary;
                selectedArtistFilter = null;
                selectedAlbumFilter = null;
                updateLibraryStats();
                renderArtistPane();
                renderAlbumPane();
                renderPlaylist(searchInput.value);
            } else {
                alert("No audio files found or directory unreadable.");
                renderPlaylist(searchInput.value);
            }
        }
    }
});

if (quickScanBtn) quickScanBtn.addEventListener('click', async () => {
    if (window.electronAPI && currentLibraryPath) {
        playlistEl.innerHTML = '<li class="empty-state">Quick scanning for new files...</li>';
        scanProgressOverlay.style.display = 'flex';
        const audioFiles = await window.electronAPI.scanLibrary({ dirPath: currentLibraryPath, fastScan: true });
        scanProgressOverlay.style.display = 'none';

        if (audioFiles && audioFiles.length > 0) {
            masterLibrary = audioFiles;
            activeTrackList = masterLibrary;
            selectedArtistFilter = null;
            selectedAlbumFilter = null;
            updateLibraryStats();
            renderArtistPane();
            renderAlbumPane();
            renderPlaylist(searchInput.value);
        } else {
            alert("No audio files found or directory unreadable.");
            renderPlaylist(searchInput.value);
        }
    }
});

if (deepScanBtn) deepScanBtn.addEventListener('click', async () => {
    if (window.electronAPI && currentLibraryPath) {
        playlistEl.innerHTML = '<li class="empty-state">Deep scanning library... This may take a moment.</li>';
        scanProgressOverlay.style.display = 'flex';
        const audioFiles = await window.electronAPI.scanLibrary({ dirPath: currentLibraryPath, fastScan: false });
        scanProgressOverlay.style.display = 'none';

        if (audioFiles && audioFiles.length > 0) {
            masterLibrary = audioFiles;
            activeTrackList = masterLibrary;
            selectedArtistFilter = null;
            selectedAlbumFilter = null;
            updateLibraryStats();
            renderArtistPane();
            renderAlbumPane();
            renderPlaylist(searchInput.value);
        } else {
            alert("No audio files found or directory unreadable.");
            renderPlaylist(searchInput.value);
        }
    }
});

clearPlBtn.addEventListener('click', () => {
    localStorage.removeItem('libraryPath');
    currentLibraryPath = null;

    masterLibrary = [];
    activeTrackList = [];
    filteredPlaylist = [];
    selectedArtistFilter = null;
    selectedAlbumFilter = null;
    currentIndex = -1;
    audio.pause();
    audio.currentTime = 0;
    trackNameDisplay.textContent = "No Track Loaded";
    timeCurrent.textContent = "0:00";
    timeTotal.textContent = "0:00";
    seekBar.value = 0;
    updateLibraryStats();
    renderArtistPane();
    renderAlbumPane();
    renderPlaylist();
});

let filteredPlaylist = [];

searchInput.addEventListener('input', () => {
    const text = searchInput.value;
    renderArtistPane(text);
    renderAlbumPane(text);
    renderPlaylist(text);
});

function renderArtistPane(filterText = '') {
    artistListEl.innerHTML = '';
    if (masterLibrary.length === 0) {
        artistListEl.innerHTML = '<li class="empty-state">...</li>';
        return;
    }

    // Apply global text filter first
    let activeTracks = masterLibrary;
    if (filterText) {
        const lowerFilter = filterText.toLowerCase();
        activeTracks = masterLibrary.filter(t =>
            (t.title && t.title.toLowerCase().includes(lowerFilter)) ||
            (t.artist && t.artist.toLowerCase().includes(lowerFilter)) ||
            (t.album && t.album.toLowerCase().includes(lowerFilter))
        );
    }

    // Calculate unique artists and their track counts
    const artistCounts = {};
    activeTracks.forEach(t => {
        const artist = t.artist || 'Unknown Artist';
        artistCounts[artist] = (artistCounts[artist] || 0) + 1;
    });

    const sortedArtists = Object.keys(artistCounts).sort((a, b) => a.localeCompare(b));

    // 'All Artists' item
    const allLi = document.createElement('li');
    allLi.className = 'playlist-item';
    if (!selectedArtistFilter) allLi.classList.add('active');
    allLi.innerHTML = `<div class="col col-artist-name">All (${sortedArtists.length} artists)</div><div class="col col-count">${activeTracks.length}</div>`;
    allLi.addEventListener('click', () => {
        selectedArtistFilter = null;
        selectedAlbumFilter = null; // Reset album as well
        renderArtistPane(searchInput.value);
        renderAlbumPane(searchInput.value);
        renderPlaylist(searchInput.value);
    });
    artistListEl.appendChild(allLi);

    sortedArtists.forEach(artist => {
        const li = document.createElement('li');
        li.className = 'playlist-item';
        if (selectedArtistFilter === artist) li.classList.add('active');

        li.innerHTML = `<div class="col col-artist-name">${artist}</div><div class="col col-count">${artistCounts[artist]}</div>`;
        li.addEventListener('click', () => {
            selectedTrackPaths.clear();
            selectedArtistFilter = artist;
            selectedAlbumFilter = null;
            renderArtistPane(searchInput.value);
            renderAlbumPane(searchInput.value);
            renderPlaylist(searchInput.value);
        });
        li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const artistTracks = masterLibrary
                .filter(t => (t.artist || 'Unknown Artist') === artist)
                .map(t => t.path);
            buildAddToPlaylistMenu(trackContextMenu, artistTracks, `Add all tracks by "${artist}":`);
            profileContextMenu.style.display = 'none';
            playlistContextMenu.style.display = 'none';
            trackContextMenu.style.display = 'flex';
            trackContextMenu.style.left = e.pageX + 'px';
            trackContextMenu.style.top = e.pageY + 'px';
        });
        artistListEl.appendChild(li);
    });
}

function renderAlbumPane(filterText = '') {
    albumListEl.innerHTML = '';
    if (masterLibrary.length === 0) {
        albumListEl.innerHTML = '<li class="empty-state">...</li>';
        return;
    }

    // Apply global text filter ONLY if no artist is selected
    let activeTracks = masterLibrary;
    if (filterText && !selectedArtistFilter) {
        const lowerFilter = filterText.toLowerCase();
        activeTracks = masterLibrary.filter(t =>
            (t.title && t.title.toLowerCase().includes(lowerFilter)) ||
            (t.artist && t.artist.toLowerCase().includes(lowerFilter)) ||
            (t.album && t.album.toLowerCase().includes(lowerFilter))
        );
    }

    // Filter albums by the selected artist first
    const baseTracks = selectedArtistFilter
        ? masterLibrary.filter(t => (t.artist || 'Unknown Artist') === selectedArtistFilter)
        : activeTracks;

    const albumCounts = {};
    baseTracks.forEach(t => {
        const album = t.album || 'Unknown Album';
        albumCounts[album] = (albumCounts[album] || 0) + 1;
    });

    const sortedAlbums = Object.keys(albumCounts).sort((a, b) => a.localeCompare(b));

    // 'All Albums' item
    const allLi = document.createElement('li');
    allLi.className = 'playlist-item';
    if (!selectedAlbumFilter) allLi.classList.add('active');
    allLi.innerHTML = `<div class="col col-album-name">All (${sortedAlbums.length} albums)</div><div class="col col-count">${baseTracks.length}</div>`;
    allLi.addEventListener('click', () => {
        selectedAlbumFilter = null;
        renderAlbumPane(searchInput.value);
        renderPlaylist(searchInput.value);
    });
    albumListEl.appendChild(allLi);

    sortedAlbums.forEach(album => {
        const li = document.createElement('li');
        li.className = 'playlist-item';
        if (selectedAlbumFilter === album) li.classList.add('active');

        li.innerHTML = `<div class="col col-album-name">${album}</div><div class="col col-count">${albumCounts[album]}</div>`;
        li.addEventListener('click', () => {
            selectedTrackPaths.clear();
            selectedAlbumFilter = album;
            renderAlbumPane(searchInput.value);
            renderPlaylist(searchInput.value);
        });
        li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const albumTracks = masterLibrary
                .filter(t => (t.album || 'Unknown Album') === album)
                .map(t => t.path);
            buildAddToPlaylistMenu(trackContextMenu, albumTracks, `Add all "${album}" tracks:`);
            profileContextMenu.style.display = 'none';
            playlistContextMenu.style.display = 'none';
            trackContextMenu.style.display = 'flex';
            trackContextMenu.style.left = e.pageX + 'px';
            trackContextMenu.style.top = e.pageY + 'px';
        });
        albumListEl.appendChild(li);
    });
}

// ── Shared helper: builds an "Add to Playlist" context menu for any set of track paths ──
function buildAddToPlaylistMenu(menuEl, trackPaths, headerLabel) {
    menuEl.innerHTML = '';
    if (userPlaylists.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'context-menu-item';
        empty.style.opacity = '0.5';
        empty.textContent = 'No Playlists Created';
        menuEl.appendChild(empty);
        return;
    }
    const header = document.createElement('div');
    header.className = 'context-menu-header';
    header.textContent = headerLabel;
    menuEl.appendChild(header);
    const divider = document.createElement('div');
    divider.className = 'context-menu-divider';
    menuEl.appendChild(divider);
    userPlaylists.forEach(pl => {
        const div = document.createElement('div');
        div.className = 'context-menu-item';
        div.textContent = `+ ${pl.name}`;
        div.addEventListener('click', () => {
            let added = 0;
            trackPaths.forEach(p => {
                if (!pl.trackPaths.includes(p)) { pl.trackPaths.push(p); added++; }
            });
            if (added > 0) savePlaylists();
        });
        menuEl.appendChild(div);
    });
}

function renderPlaylist(filterText = '') {
    playlistEl.innerHTML = '';

    // Filter logic
    filteredPlaylist = activeTrackList;

    // 1. Pane Filters (Dominant)
    if (selectedArtistFilter) {
        filteredPlaylist = filteredPlaylist.filter(t => (t.artist || 'Unknown Artist') === selectedArtistFilter);
    }
    if (selectedAlbumFilter) {
        filteredPlaylist = filteredPlaylist.filter(t => (t.album || 'Unknown Album') === selectedAlbumFilter);
    }

    // 2. Text Search Filter (Ignored if Panes are active)
    if (filterText && !selectedArtistFilter && !selectedAlbumFilter) {
        const lowerFilter = filterText.toLowerCase();
        filteredPlaylist = filteredPlaylist.filter(t =>
            (t.title && t.title.toLowerCase().includes(lowerFilter)) ||
            (t.artist && t.artist.toLowerCase().includes(lowerFilter)) ||
            (t.album && t.album.toLowerCase().includes(lowerFilter))
        );
    }

    // Sort: when viewing a specific album OR a custom playlist, sort by track number
    // first (artist varies for collaboration tracks e.g. "Artist A & Artist B"). 
    // In the full library view, sort Artist → Album → Track Number as before.
    filteredPlaylist.sort((a, b) => {
        // Skip artist sort if we are looking at a specific album or a custom playlist
        if (!selectedAlbumFilter && !activePlaylistId) {
            const artistA = (a.artist || 'Unknown Artist').toLowerCase();
            const artistB = (b.artist || 'Unknown Artist').toLowerCase();
            if (artistA !== artistB) return artistA.localeCompare(artistB);
        }

        const albumA = (a.album || 'Unknown Album').toLowerCase();
        const albumB = (b.album || 'Unknown Album').toLowerCase();
        if (albumA !== albumB) return albumA.localeCompare(albumB);

        const trackA = parseInt(a.trackNo) || 999;
        const trackB = parseInt(b.trackNo) || 999;
        return (trackA - trackB) * trackSortDirection;
    });

    if (filteredPlaylist.length === 0) {
        playlistEl.innerHTML = '<li class="empty-state">No music found. Set a Library Path to begin.</li>';
        return;
    }

    filteredPlaylist.forEach((track, visualIdx) => {
        const li = document.createElement('li');
        li.className = 'playlist-item';

        const originalIndex = activeTrackList.indexOf(track);
        if (originalIndex === currentIndex) li.classList.add('active');
        if (selectedTrackPaths.has(track.path)) li.classList.add('selected');

        // --- Selection: click / Ctrl+click / Shift+click ---
        li.addEventListener('click', (e) => {
            if (e.shiftKey && lastClickedVisualIdx >= 0) {
                const lo = Math.min(lastClickedVisualIdx, visualIdx);
                const hi = Math.max(lastClickedVisualIdx, visualIdx);
                filteredPlaylist.slice(lo, hi + 1).forEach(t => selectedTrackPaths.add(t.path));
            } else if (e.ctrlKey || e.metaKey) {
                if (selectedTrackPaths.has(track.path)) selectedTrackPaths.delete(track.path);
                else selectedTrackPaths.add(track.path);
                lastClickedVisualIdx = visualIdx;
            } else {
                selectedTrackPaths.clear();
                selectedTrackPaths.add(track.path);
                lastClickedVisualIdx = visualIdx;
            }
            // Update selection visuals in-place
            document.querySelectorAll('#playlist .playlist-item').forEach((el, i) => {
                el.classList.toggle('selected', selectedTrackPaths.has(filteredPlaylist[i]?.path));
            });
        });

        // --- Context Menu ---
        li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            // If right-clicked item isn't in selection, snap selection to just this track
            if (!selectedTrackPaths.has(track.path)) {
                selectedTrackPaths.clear();
                selectedTrackPaths.add(track.path);
                lastClickedVisualIdx = visualIdx;
                document.querySelectorAll('#playlist .playlist-item').forEach((el, i) => {
                    el.classList.toggle('selected', selectedTrackPaths.has(filteredPlaylist[i]?.path));
                });
            }

            trackContextMenu.innerHTML = '';

            if (activePlaylistId) {
                const removeDiv = document.createElement('div');
                removeDiv.className = 'context-menu-item delete';
                removeDiv.textContent = selectedTrackPaths.size > 1
                    ? `Remove ${selectedTrackPaths.size} tracks from Playlist`
                    : 'Remove from Playlist';
                removeDiv.addEventListener('click', () => {
                    const pl = userPlaylists.find(p => p.id === activePlaylistId);
                    if (pl) {
                        pl.trackPaths = pl.trackPaths.filter(p => !selectedTrackPaths.has(p));
                        savePlaylists();
                        selectedTrackPaths.clear();
                        const activePlLi = document.querySelector(`.user-playlist-item[data-id="${activePlaylistId}"]`);
                        if (activePlLi) activePlLi.click();
                    }
                });
                trackContextMenu.appendChild(removeDiv);
            } else {
                const countLabel = selectedTrackPaths.size > 1
                    ? `Add ${selectedTrackPaths.size} tracks to Playlist:`
                    : 'Add to Playlist:';
                buildAddToPlaylistMenu(trackContextMenu, Array.from(selectedTrackPaths), countLabel);
            }

            profileContextMenu.style.display = 'none';
            playlistContextMenu.style.display = 'none';
            trackContextMenu.style.display = 'flex';
            trackContextMenu.style.left = e.pageX + 'px';
            trackContextMenu.style.top = e.pageY + 'px';
        });

        const trackDiv = document.createElement('div');
        trackDiv.className = 'col col-track';
        trackDiv.textContent = track.trackNo || '-';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'col col-title';
        titleDiv.textContent = track.title || track.name;

        const artistDiv = document.createElement('div');
        artistDiv.className = 'col col-artist';
        artistDiv.textContent = track.artist || 'Unknown Artist';

        const albumDiv = document.createElement('div');
        albumDiv.className = 'col col-album';
        albumDiv.textContent = track.album || 'Unknown Album';

        const timeDiv = document.createElement('div');
        timeDiv.className = 'col col-time';
        timeDiv.textContent = formatTime(track.duration || 0);

        li.appendChild(trackDiv);
        li.appendChild(titleDiv);
        li.appendChild(artistDiv);
        li.appendChild(albumDiv);
        li.appendChild(timeDiv);

        li.addEventListener('dblclick', () => {
            // Snapshot the visible tracks into the playback queue
            playbackQueue = [...filteredPlaylist];
            const newIndex = playbackQueue.findIndex(t => t.path === track.path);
            loadTrack(newIndex);
        });
        playlistEl.appendChild(li);
    });
}

// Boot loader for Cached Library
if (window.electronAPI) {
    window.electronAPI.getLibrary().then(cachedLibrary => {
        if (cachedLibrary && cachedLibrary.length > 0) {
            masterLibrary = cachedLibrary;
            activeTrackList = masterLibrary;
            updateLibraryStats();
            renderArtistPane();
            renderAlbumPane();
            renderPlaylist();
        }
    });
}

// Initial volume
audio.volume = volumeBar.value / 100;

// --- Dynamic YouTube Profiles ---

function createYoutubeWebview(profile) {
    const webview = document.createElement('webview');
    webview.id = `yt-webview-${profile.id}`;
    webview.src = "https://music.youtube.com";
    webview.setAttribute('allowpopups', '');
    webview.setAttribute('webpreferences', 'allowRunningInsecureContent=true');
    webview.partition = `persist:${profile.id}`; // Isolate the session!

    webview.addEventListener('dom-ready', async () => {
        console.log(`YouTube Webview [${profile.name}] is ready.`);
        if (!window.electronAPI || !window.electronAPI.getLocalServerUrl) return;

        const serverUrl = await window.electronAPI.getLocalServerUrl();
        if (!serverUrl) return;

        const wsUrl = serverUrl.replace('http://', 'ws://');

        const injectCode = `
          try {
            if (!window.__ytAudioHooked) {
              window.__ytAudioHooked = true;
              let ws = new WebSocket("${wsUrl}");
              ws.onclose = () => { setTimeout(() => { ws = new WebSocket("${wsUrl}"); }, 3000); };

              window.ytAudioCtx = new AudioContext();
              window.ytAudioDest = window.ytAudioCtx.createMediaStreamDestination();
              window.ytMediaRecorder = new MediaRecorder(window.ytAudioDest.stream, { mimeType: 'audio/webm;codecs=opus' });
              
              window.ytMediaRecorder.ondataavailable = async (e) => {
                  if (e.data.size > 0 && ws.readyState === 1) { // 1 = OPEN
                      ws.send(await e.data.arrayBuffer());
                  }
              };
              window.ytMediaRecorder.start(100);

              window.ytVideoSource = null;
              window.ytOutputMode = 'local';

              window.setYtOutput = function(mode) {
                 window.ytOutputMode = mode;
                 if (window.ytVideoSource) {
                    window.ytAudioCtx.resume();
                    window.ytVideoSource.disconnect();
                    
                    if (mode === 'sonos') {
                        // Only pipe to Sonos
                        window.ytVideoSource.connect(window.ytAudioDest);
                    } else if (mode === 'local') {
                       // Pipe to Sonos (always) and local speakers
                       window.ytVideoSource.connect(window.ytAudioDest);
                       window.ytVideoSource.connect(window.ytAudioCtx.destination);
                    }
                    // if mode === 'muted', we just leave it disconnected
                 }
                 return true;
              };

              // Constantly poll for the video element and hook it
              setInterval(() => {
                 const videoEl = document.querySelector('video');
                 if (videoEl && !window.ytVideoSource) {
                     window.ytVideoSource = window.ytAudioCtx.createMediaElementSource(videoEl);
                     window.setYtOutput(window.ytOutputMode);
                 }
              }, 2000);
            }
          } catch(e) { console.error('Audio Hook Error:', e); }
          undefined;
        `;

        webview.executeJavaScript(injectCode).catch(e => {
            console.error(`Failed to inject into [${profile.name}]:`, e);
        });

        const currentDevice = getActualSelectedDevice();
        const mode = (currentDevice && currentDevice !== 'local') ? 'sonos' : 'local';
        webview.executeJavaScript(`if(window.setYtOutput) window.setYtOutput("${mode}"); undefined;`);
    });

    webview.addEventListener('console-message', (e) => {
        console.log(`YT [${profile.name}]:`, e.message);
    });

    return webview;
}

function renderProfiles() {
    // Clear out standard profile links but keep the "Add Profile" button
    document.querySelectorAll('.profile-item').forEach(el => el.remove());

    ytProfiles.forEach((profile) => {
        // Create Sidebar Item
        const li = document.createElement('li');
        li.className = 'profile-item';
        li.textContent = profile.name;
        li.dataset.id = profile.id;
        li.title = "Double click to rename";

        // --- Context Menu Logic ---
        li.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            rightClickedProfileId = profile.id;
            rightClickedProfileLi = li;

            profileContextMenu.style.display = 'flex';
            profileContextMenu.style.left = e.pageX + 'px';
            profileContextMenu.style.top = e.pageY + 'px';
        });

        li.addEventListener('blur', function () {
            li.contentEditable = "false";
            profile.name = li.textContent.trim() || 'Unnamed Profile';
            li.textContent = profile.name; // Reset in case it was blank
            saveProfiles();
        });

        li.addEventListener('keypress', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                li.blur();
            }
        });

        // Insert into sidebar before the "Add Account" button
        ytProfilesList.insertBefore(li, addProfileBtn.parentElement);

        // --- Create / Load Webview Container ---
        let webviewContainer = document.getElementById(`view-yt-${profile.id}`);
        if (!webviewContainer) {
            webviewContainer = document.createElement('section');
            webviewContainer.id = `view-yt-${profile.id}`;
            webviewContainer.className = 'view dt-webview-container';

            const webview = createYoutubeWebview(profile);
            webviewContainer.appendChild(webview);
            dynamicViewsContainer.appendChild(webviewContainer);

            activeWebviews[profile.id] = webview;
        }

        // --- Navigation Activation Logic ---
        li.addEventListener('click', () => {
            if (li.contentEditable === "true") return; // don't navigate if renaming

            deactivateAllViews();
            li.classList.add('active');
            webviewContainer.classList.add('active-view');
            playerBar.classList.add('hidden'); // Hide local player bar

            // Stop local music playback 
            if (!audio.paused) {
                togglePlayPause();
            }

            // Direct Sonos flow dynamically to this specific webview
            const selectedDevice = getActualSelectedDevice();
            if (selectedDevice && selectedDevice !== 'local') {
                if (window.electronAPI) {
                    window.electronAPI.playYtOnSonos(selectedDevice).catch(err => console.error(err));
                }
            }
        });
    });
}

// Add New Profile Handler
addProfileBtn.addEventListener('click', () => {
    const newProfile = {
        id: 'yt-' + Date.now().toString(),
        name: `YouTube Profile ${ytProfiles.length + 1}`
    };
    ytProfiles.push(newProfile);
    saveProfiles();
    renderProfiles();
});

// ======================================
// --- Now Playing Queue Logic ---
// ======================================

function openQueue() {
    closeSettings(); // Ensure settings is closed
    queuePanel.classList.add('open');
    queueOverlay.style.display = 'block';
    queueBtn.classList.add('active');
    renderQueue();
}

function closeQueue() {
    queuePanel.classList.remove('open');
    queueOverlay.style.display = 'none';
    queueBtn.classList.remove('active');
    queueSaveName.value = ''; // Reset input
}

queueBtn.addEventListener('click', () => {
    if (queuePanel.classList.contains('open')) closeQueue();
    else openQueue();
});
closeQueueBtn.addEventListener('click', closeQueue);
queueOverlay.addEventListener('click', closeQueue);

function renderQueue() {
    queueTrackList.innerHTML = '';

    if (playbackQueue.length === 0) {
        queueTrackList.innerHTML = '<li class="queue-item" style="justify-content:center; opacity:0.5;">Queue is empty</li>';
        return;
    }

    playbackQueue.forEach((track, idx) => {
        const li = document.createElement('li');
        li.className = 'queue-item';
        if (idx === currentIndex) {
            li.classList.add('active');
        }

        const numDiv = document.createElement('div');
        numDiv.className = 'queue-item-num';
        numDiv.textContent = idx + 1;

        const infoDiv = document.createElement('div');
        infoDiv.className = 'queue-item-info';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'queue-item-title';
        titleDiv.textContent = track.title || track.name;

        const artistDiv = document.createElement('div');
        artistDiv.className = 'queue-item-artist';
        artistDiv.textContent = track.artist || 'Unknown Artist';

        infoDiv.appendChild(titleDiv);
        infoDiv.appendChild(artistDiv);

        li.appendChild(numDiv);
        li.appendChild(infoDiv);

        li.addEventListener('click', () => {
            loadTrack(idx);
        });

        queueTrackList.appendChild(li);

        // Auto-scroll to the currently playing track
        if (idx === currentIndex) {
            // Need a slight timeout to ensure it's attached to DOM before scrolling
            setTimeout(() => {
                li.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 10);
        }
    });
}

queueSaveBtn.addEventListener('click', () => {
    if (playbackQueue.length === 0) return;

    let playlistName = queueSaveName.value.trim();
    if (!playlistName) {
        const dateObj = new Date();
        playlistName = `Queue - ${dateObj.toLocaleDateString()} ${dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    const newPlaylist = {
        id: 'pl-' + Date.now().toString(),
        name: playlistName,
        trackPaths: playbackQueue.map(t => t.path)
    };

    userPlaylists.push(newPlaylist);
    savePlaylists();
    renderPlaylists();

    // Quick feedback
    const originalText = queueSaveBtn.textContent;
    queueSaveBtn.textContent = "Saved!";
    queueSaveBtn.disabled = true;
    queueSaveName.value = '';

    setTimeout(() => {
        queueSaveBtn.textContent = originalText;
        queueSaveBtn.disabled = false;
        closeQueue();
    }, 1500);
});

// ======================================
// --- Custom Playlists Logic ---
// ======================================

function savePlaylists() {
    localStorage.setItem('userPlaylists', JSON.stringify(userPlaylists));
}

function renderPlaylists() {
    // Clear out existing playlist items, keep the + Add button
    document.querySelectorAll('.user-playlist-item').forEach(el => el.remove());

    userPlaylists.forEach(playlist => {
        const li = document.createElement('li');
        li.className = 'profile-item user-playlist-item';
        li.textContent = playlist.name;
        li.dataset.id = playlist.id;
        li.title = "Double click to rename";

        if (activePlaylistId === playlist.id) {
            li.classList.add('active');
        }

        // Context Menu (Right Click)
        li.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            rightClickedPlaylistId = playlist.id;
            rightClickedPlaylistLi = li;

            profileContextMenu.style.display = 'none';
            trackContextMenu.style.display = 'none';
            playlistContextMenu.style.display = 'flex';
            playlistContextMenu.style.left = e.pageX + 'px';
            playlistContextMenu.style.top = e.pageY + 'px';
        });

        // Click to View
        li.addEventListener('click', () => {
            if (li.contentEditable === "true") return;

            // Reset UI states
            deactivateAllViews();
            document.querySelectorAll('.user-playlist-item').forEach(el => el.classList.remove('active'));
            li.classList.add('active');
            viewLocal.classList.add('active-view');
            playerBar.classList.remove('hidden');

            activePlaylistId = playlist.id;

            // Filter the active track list to ONLY include tracks in this playlist
            // Match against masterLibrary based on file paths
            activeTrackList = masterLibrary.filter(t => playlist.trackPaths.includes(t.path));

            // Clear panes because we don't need Artist/Album filtering in a custom playlist
            selectedArtistFilter = null;
            selectedAlbumFilter = null;
            artistListEl.innerHTML = '<li class="empty-state">Filtered by Playlist</li>';
            albumListEl.innerHTML = '<li class="empty-state">Filtered by Playlist</li>';

            renderPlaylist(searchInput.value);
        });

        // Rename logic handling
        li.addEventListener('blur', function () {
            li.contentEditable = "false";
            playlist.name = li.textContent.trim() || 'Unnamed Playlist';
            li.textContent = playlist.name;
            savePlaylists();
        });

        li.addEventListener('keypress', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                li.blur();
            }
        });

        playlistNavList.insertBefore(li, addPlaylistBtn.parentElement);
    });
}

// Global click dismisses contexts
document.addEventListener('click', () => {
    profileContextMenu.style.display = 'none';
    playlistContextMenu.style.display = 'none';
    trackContextMenu.style.display = 'none';
});

// Sidebar Playlist Context Actions
plContextRename.addEventListener('click', () => {
    if (rightClickedPlaylistLi) {
        rightClickedPlaylistLi.contentEditable = "true";
        rightClickedPlaylistLi.focus();
        const range = document.createRange();
        range.selectNodeContents(rightClickedPlaylistLi);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
});

plContextDelete.addEventListener('click', async () => {
    if (rightClickedPlaylistId) {
        const pl = userPlaylists.find(p => p.id === rightClickedPlaylistId);
        const plName = pl ? pl.name : 'this playlist';
        if (await customConfirm(`Are you sure you want to delete "${plName}"?`)) {
            userPlaylists = userPlaylists.filter(p => p.id !== rightClickedPlaylistId);
            savePlaylists();

            if (activePlaylistId === rightClickedPlaylistId) {
                // Return to main library if we deleted what we were looking at
                navLocal.click();
            } else {
                renderPlaylists();
            }
        }
    }
});

addPlaylistBtn.addEventListener('click', () => {
    const newPl = {
        id: 'pl-' + Date.now(),
        name: `New Playlist ${userPlaylists.length + 1}`,
        trackPaths: []
    };
    userPlaylists.push(newPl);
    savePlaylists();
    renderPlaylists();
});

// Setup on boot
renderProfiles();
renderPlaylists();

// Override local nav click to restore masterLibrary tracking
const originalNavLocalClick = navLocal.onclick;
navLocal.addEventListener('click', () => {
    activePlaylistId = null;
    activeTrackList = masterLibrary;
    document.querySelectorAll('.user-playlist-item').forEach(el => el.classList.remove('active'));
    renderArtistPane();
    renderAlbumPane();
    renderPlaylist(searchInput.value);
});


// --- Sonos Playback Progress Sync ---
function timeStringToSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return 0;
}

if (window.electronAPI && window.electronAPI.onSonosProgress) {
    window.electronAPI.onSonosProgress((event, data) => {
        const selectedDevice = getActualSelectedDevice();
        if (selectedDevice && selectedDevice !== 'local') {
            const currentSec = timeStringToSeconds(data.current);
            const totalSec = timeStringToSeconds(data.total);

            timeCurrent.textContent = formatTime(currentSec);
            timeTotal.textContent = formatTime(totalSec);

            if (totalSec > 0) {
                seekBar.max = totalSec;
                seekBar.value = currentSec;
            }
        }
    });
}

// ======================================
// --- Custom Confirm Modal Logic ---
// ======================================
function customConfirm(messageText) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('custom-confirm-overlay');
        const modal = document.getElementById('custom-confirm-modal');
        const messageEl = document.getElementById('custom-confirm-message');
        const btnCancel = document.getElementById('custom-confirm-cancel');
        const btnOk = document.getElementById('custom-confirm-ok');

        messageEl.textContent = messageText;
        overlay.classList.add('active');
        modal.classList.add('open');

        function cleanup() {
            overlay.classList.remove('active');
            modal.classList.remove('open');
            btnCancel.removeEventListener('click', onCancel);
            btnOk.removeEventListener('click', onOk);
            overlay.removeEventListener('click', onCancel);
        }

        function onCancel() {
            cleanup();
            resolve(false);
        }

        function onOk() {
            cleanup();
            resolve(true);
        }

        btnCancel.addEventListener('click', onCancel);
        btnOk.addEventListener('click', onOk);
        overlay.addEventListener('click', onCancel);
    });
}
