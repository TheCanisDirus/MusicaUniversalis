const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    selectLibrary: () => ipcRenderer.invoke('dialog:openDirectory'),
    readLibrary: (dirPath) => ipcRenderer.invoke('fs:readDirectory', dirPath),

    onSonosDevices: (callback) => ipcRenderer.on('sonos:deviceList', callback),
    onSonosProgress: (callback) => ipcRenderer.on('sonos-progress', callback),
    playOnSonos: (host, filePath) => ipcRenderer.invoke('sonos:play', { host, filePath }),
    playYtOnSonos: (host) => ipcRenderer.invoke('sonos:playYt', { host }),
    pauseSonos: (host, pause) => ipcRenderer.invoke('sonos:pause', { host, pause }),
    setSonosVolume: (host, volume) => ipcRenderer.invoke('sonos:setVolume', { host, volume }),
    getSonosState: (host) => ipcRenderer.invoke('sonos:getState', { host }),
    getLocalServerUrl: () => ipcRenderer.invoke('get-server-url'),
    getDesktopAudioSourceId: () => ipcRenderer.invoke('get-desktop-audio-id'),

    scanLibrary: (options) => ipcRenderer.invoke('scan-library', options),
    getLibrary: () => ipcRenderer.invoke('get-library'),
    getAlbumArt: (filePath) => ipcRenderer.invoke('get-album-art', filePath),
    onScanProgress: (callback) => ipcRenderer.on('scan-progress', callback),

    setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    minimizeWindow: () => ipcRenderer.send('window:minimize'),
    maximizeWindow: () => ipcRenderer.send('window:maximize'),
    closeWindow: () => ipcRenderer.send('window:close')
});
