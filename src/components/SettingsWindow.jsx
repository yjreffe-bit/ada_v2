import React, { useState, useEffect } from 'react';
import { Copy, X } from 'lucide-react';

const TOOLS = [
    { id: 'generate_cad', label: 'Generate CAD' },
    { id: 'generate_content_video', label: 'Generate Content Video' },
    { id: 'run_web_agent', label: 'Web Agent' },
    { id: 'create_directory', label: 'Create Folder' },
    { id: 'write_file', label: 'Write File' },
    { id: 'read_directory', label: 'Read Directory' },
    { id: 'read_file', label: 'Read File' },
    { id: 'create_project', label: 'Create Project' },
    { id: 'switch_project', label: 'Switch Project' },
    { id: 'list_projects', label: 'List Projects' },
    { id: 'list_smart_devices', label: 'List Devices' },
    { id: 'control_light', label: 'Control Light' },
    { id: 'discover_printers', label: 'Discover Printers' },
    { id: 'print_stl', label: 'Print 3D Model' },
    { id: 'iterate_cad', label: 'Iterate CAD' },
];

const CONNECTION_ROWS = [
    { id: 'canva', label: 'Canva', provider: 'canva' },
    { id: 'youtube', label: 'YouTube', provider: 'youtube' },
    { id: 'facebook', label: 'Facebook', provider: 'meta' },
    { id: 'instagram', label: 'Instagram', provider: 'meta' },
    { id: 'tiktok', label: 'TikTok', provider: 'tiktok' },
];

const checklistFor = (row, status) => {
    const idReady = Boolean(status.client_id);
    const secretReady = Boolean(status.secret_set);
    if (row.id === 'youtube') {
        return [
            { done: idReady, text: 'Client ID is filled in. Replace it only if you created your own.' },
            { done: secretReady, text: 'Paste the Client Secret from Google Cloud.' },
        ];
    }
    if (row.id === 'facebook') {
        return [
            { done: idReady, text: 'App ID is filled in. Replace it only if this is not your Meta app.' },
            { done: secretReady, text: 'Paste the App Secret from Meta for Developers.' },
        ];
    }
    if (row.id === 'instagram') {
        return [
            { done: idReady, text: 'Uses the same Meta App ID as Facebook.' },
            { done: secretReady, text: 'Uses the same Meta App Secret as Facebook.' },
        ];
    }
    if (row.id === 'tiktok') {
        return [
            { done: idReady, text: 'Paste the Client Key from TikTok for Developers.' },
            { done: secretReady, text: 'Paste the Client Secret from the same app.' },
        ];
    }
    return [
        { done: idReady, text: 'Paste the Client ID from the Canva Developer Portal.' },
        { done: secretReady, text: 'Paste the Client Secret from the same page.' },
    ];
};

const openLoginPage = (url) => {
    try {
        const electron = window.require ? window.require('electron') : null;
        if (electron?.shell?.openExternal) {
            electron.shell.openExternal(url);
            return;
        }
    } catch (err) {
        // Vite in a normal browser has no Electron shell.
    }
    window.open(url, '_blank', 'noopener');
};

const SettingsWindow = ({
    socket,
    micDevices,
    speakerDevices,
    webcamDevices,
    selectedMicId,
    setSelectedMicId,
    selectedSpeakerId,
    setSelectedSpeakerId,
    selectedWebcamId,
    setSelectedWebcamId,
    cursorSensitivity,
    setCursorSensitivity,
    isCameraFlipped,
    setIsCameraFlipped,
    handleFileUpload,
    mobileLayout = false,
    embedded = false,
    onClose
}) => {
    const [permissions, setPermissions] = useState({});
    const [faceAuthEnabled, setFaceAuthEnabled] = useState(false);
    const [connections, setConnections] = useState({});
    const [oauthMessage, setOauthMessage] = useState('');
    const [loginUrl, setLoginUrl] = useState('');
    const [busyProvider, setBusyProvider] = useState('');
    const [drafts, setDrafts] = useState({});
    const [copiedId, setCopiedId] = useState('');

    useEffect(() => {
        // Request initial permissions
        socket.emit('get_settings');

        // Listen for updates
        const handleSettings = (settings) => {
            console.log("Received settings:", settings);
            if (settings) {
                if (settings.tool_permissions) setPermissions(settings.tool_permissions);
                if (typeof settings.face_auth_enabled !== 'undefined') {
                    setFaceAuthEnabled(settings.face_auth_enabled);
                    localStorage.setItem('face_auth_enabled', settings.face_auth_enabled);
                }
            }
        };

        const handleConnections = (rows) => {
            const next = {};
            (rows || []).forEach((row) => {
                next[row.id] = row;
            });
            setConnections(next);
            setBusyProvider('');
            setDrafts((prev) => {
                const updated = { ...prev };
                Object.values(next).forEach((row) => {
                    if (updated[row.provider]?.dirty) return;
                    updated[row.provider] = {
                        clientId: row.client_id || '',
                        clientSecret: '',
                        dirty: false,
                    };
                });
                return updated;
            });
        };
        const handleOauthMessage = (payload) => {
            setOauthMessage(payload?.message || '');
            setBusyProvider('');
            setLoginUrl(payload?.opened ? '' : (payload?.url || ''));
        };

        socket.on('settings', handleSettings);
        socket.on('connections', handleConnections);
        socket.on('oauth_message', handleOauthMessage);
        socket.emit('get_connections');

        return () => {
            socket.off('settings', handleSettings);
            socket.off('connections', handleConnections);
            socket.off('oauth_message', handleOauthMessage);
        };
    }, [socket]);

    const updateDraft = (provider, field, value) => {
        setDrafts((prev) => ({
            ...prev,
            [provider]: {
                clientId: prev[provider]?.clientId || '',
                clientSecret: prev[provider]?.clientSecret || '',
                dirty: true,
                [field]: value,
            },
        }));
    };

    const credentialPayload = (provider) => {
        const draft = drafts[provider] || {};
        return {
            provider,
            client_id: draft.clientId || '',
            client_secret: draft.clientSecret || '',
        };
    };

    const saveCredentials = (provider) => {
        setOauthMessage('');
        setDrafts((prev) => ({
            ...prev,
            [provider]: { ...(prev[provider] || {}), clientSecret: '', dirty: false },
        }));
        socket.emit('oauth_save_credentials', credentialPayload(provider));
    };

    const connectService = (provider) => {
        setBusyProvider(provider);
        setOauthMessage('');
        setLoginUrl('');
        const payload = credentialPayload(provider);
        setDrafts((prev) => ({
            ...prev,
            [provider]: { ...(prev[provider] || {}), clientSecret: '', dirty: false },
        }));
        socket.emit('oauth_connect', payload);
    };

    const copyRedirect = async (rowId, url) => {
        if (!url) return;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(url);
            } else {
                throw new Error('clipboard unavailable');
            }
        } catch (err) {
            const area = document.createElement('textarea');
            area.value = url;
            area.setAttribute('readonly', '');
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            area.remove();
        }
        setCopiedId(rowId);
    };

    const disconnectService = (service) => {
        setOauthMessage('');
        socket.emit('oauth_disconnect', { service });
    };

    const togglePermission = (toolId) => {
        const currentVal = permissions[toolId] !== false; // Default True
        const nextVal = !currentVal;

        // Update local mostly for responsiveness, but socket roundtrip handles truth
        // setPermissions(prev => ({ ...prev, [toolId]: nextVal }));

        // Send update
        socket.emit('update_settings', { tool_permissions: { [toolId]: nextVal } });
    };

    const toggleFaceAuth = () => {
        const newVal = !faceAuthEnabled;
        setFaceAuthEnabled(newVal); // Optimistic Update
        localStorage.setItem('face_auth_enabled', newVal);
        socket.emit('update_settings', { face_auth_enabled: newVal });
    };

    const toggleCameraFlip = () => {
        const newVal = !isCameraFlipped;
        setIsCameraFlipped(newVal);
        socket.emit('update_settings', { camera_flipped: newVal });
    };

    return (
        <div className={embedded
            ? 'w-full text-[#E6FBFF]'
            : `${mobileLayout ? 'fixed left-3 right-3 top-[calc(env(safe-area-inset-top)+6rem)] bottom-3 w-auto overflow-hidden' : 'absolute top-16 right-6 w-[30rem]'} bg-black/90 border border-cyan-500/50 p-4 rounded-lg z-50 backdrop-blur-xl shadow-[0_0_30px_rgba(6,182,212,0.2)]`}>
            {!embedded && (
            <div className="flex justify-between items-center mb-4 border-b border-cyan-900/50 pb-2">
                <h2 className="text-cyan-400 font-bold text-sm uppercase tracking-wider">Settings</h2>
                <button onClick={onClose} className="text-cyan-600 hover:text-cyan-400">
                    <X size={16} />
                </button>
            </div>
            )}

            <div className={embedded ? '' : 'max-h-[calc(100vh-8rem)] overflow-y-auto pr-1'}>

            {/* Connections */}
            <div className="mb-6">
                <h3 className="text-cyan-400 font-bold mb-1 text-xs uppercase tracking-wider opacity-80">Connections</h3>
                <p className="text-[10px] text-cyan-500/70 mb-3">Paste the id and secret here. They stay on this PC. A value in .env overrides the panel. Facebook and Instagram share one Meta login.</p>
                <div className="space-y-3">
                    {CONNECTION_ROWS.map((row) => {
                        const status = connections[row.id] || {};
                        const draft = drafts[row.provider] || {};
                        const connected = Boolean(status.connected);
                        const busy = busyProvider === row.provider;
                        const idLocked = status.client_id_source === 'env';
                        const secretLocked = status.secret_source === 'env';
                        const steps = checklistFor(row, status);
                        return (
                            <div key={row.id} className="text-xs bg-gray-900/50 p-2 rounded border border-cyan-900/30">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-cyan-100/90">{row.label}</span>
                                    <span className={connected ? 'text-emerald-300' : 'text-cyan-500/70'}>
                                        {connected ? 'Connected' : 'Not connected'}
                                    </span>
                                </div>
                                <ol className="mt-2 space-y-1">
                                    {steps.map((step) => (
                                        <li key={step.text} className="flex gap-2 text-[10px] text-cyan-100/75">
                                            <span className={step.done ? 'text-emerald-300' : 'text-cyan-600'}>{step.done ? '✓' : '○'}</span>
                                            <span>{step.text}</span>
                                        </li>
                                    ))}
                                    <li className="flex gap-2 text-[10px] text-cyan-100/75">
                                        <span className="text-cyan-600">○</span>
                                        <span>Register this redirect URL, then click Connect.</span>
                                    </li>
                                </ol>
                                <label className="block text-[10px] text-cyan-500/80 mt-2">{status.id_label || 'Client ID'}</label>
                                <input
                                    value={draft.clientId || ''}
                                    readOnly={idLocked}
                                    onChange={(event) => updateDraft(row.provider, 'clientId', event.target.value)}
                                    className="w-full mt-1 bg-gray-950 border border-cyan-900 rounded p-1.5 text-[10px] text-cyan-100 outline-none focus:border-cyan-400"
                                    spellCheck="false"
                                    autoComplete="off"
                                />
                                {idLocked && <p className="text-[10px] text-cyan-500/70 mt-1">Using the id from .env.</p>}
                                <label className="block text-[10px] text-cyan-500/80 mt-2">{status.secret_label || 'Client Secret'}</label>
                                <input
                                    type="password"
                                    value={secretLocked ? '' : (draft.clientSecret || '')}
                                    readOnly={secretLocked}
                                    placeholder={secretLocked ? 'Using the secret from .env' : (status.secret_set ? 'Saved on this PC. Paste to replace.' : 'Paste secret')}
                                    onChange={(event) => updateDraft(row.provider, 'clientSecret', event.target.value)}
                                    className="w-full mt-1 bg-gray-950 border border-cyan-900 rounded p-1.5 text-[10px] text-cyan-100 outline-none focus:border-cyan-400"
                                    autoComplete="new-password"
                                />
                                <label className="block text-[10px] text-cyan-500/80 mt-2">Redirect URL</label>
                                <div className="flex gap-1 mt-1">
                                    <input
                                        readOnly
                                        value={status.redirect_uri || ''}
                                        className="flex-1 min-w-0 bg-gray-950 border border-cyan-900 rounded p-1.5 text-[10px] text-cyan-100 outline-none"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => copyRedirect(row.id, status.redirect_uri)}
                                        className="px-2 rounded border border-cyan-500/50 text-cyan-200 inline-flex items-center gap-1"
                                    >
                                        <Copy size={12} />
                                        {copiedId === row.id ? 'Copied' : 'Copy'}
                                    </button>
                                </div>
                                <p className="text-[10px] text-cyan-100/60 mt-2">{status.detail || 'Checking...'}</p>
                                <div className="flex gap-2 mt-2">
                                    <button
                                        onClick={() => saveCredentials(row.provider)}
                                        className="px-2 py-1 rounded border border-cyan-900 text-cyan-300 hover:bg-cyan-500/10"
                                    >
                                        Save
                                    </button>
                                    <button
                                        onClick={() => connectService(row.provider)}
                                        disabled={busy}
                                        className="px-2 py-1 rounded border border-cyan-500/50 text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-50"
                                    >
                                        {busy ? 'Opening...' : 'Connect'}
                                    </button>
                                    {status.stored && (
                                        <button
                                            onClick={() => disconnectService(row.id)}
                                            className="px-2 py-1 rounded border border-cyan-900 text-cyan-400/80 hover:bg-cyan-500/10"
                                        >
                                            Disconnect
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
                {oauthMessage && <p className="text-[10px] text-cyan-200 mt-2">{oauthMessage}</p>}
                {loginUrl && (
                    <button
                        onClick={() => openLoginPage(loginUrl)}
                        className="mt-2 text-[10px] uppercase tracking-wider text-cyan-300 underline"
                    >
                        Open login page
                    </button>
                )}
            </div>

            {/* Authentication Section */}
            <div className="mb-6">
                <h3 className="text-cyan-400 font-bold mb-3 text-xs uppercase tracking-wider opacity-80">Security</h3>
                <div className="flex items-center justify-between text-xs bg-gray-900/50 p-2 rounded border border-cyan-900/30">
                    <span className="text-cyan-100/80">Face Authentication</span>
                    <button
                        onClick={toggleFaceAuth}
                        className={`relative w-8 h-4 rounded-full transition-colors duration-200 ${faceAuthEnabled ? 'bg-cyan-500/80' : 'bg-gray-700'}`}
                    >
                        <div
                            className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform duration-200 ${faceAuthEnabled ? 'translate-x-4' : 'translate-x-0'}`}
                        />
                    </button>
                </div>
            </div>

            {/* Microphone Section */}
            <div className="mb-4">
                <h3 className="text-cyan-400 font-bold mb-2 text-xs uppercase tracking-wider opacity-80">Microphone</h3>
                <select
                    value={selectedMicId}
                    onChange={(e) => setSelectedMicId(e.target.value)}
                    className="w-full bg-gray-900 border border-cyan-800 rounded p-2 text-xs text-cyan-100 focus:border-cyan-400 outline-none"
                >
                    {micDevices.map((device, i) => (
                        <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Microphone ${i + 1}`}
                        </option>
                    ))}
                </select>
            </div>

            {/* Speaker Section */}
            <div className="mb-4">
                <h3 className="text-cyan-400 font-bold mb-2 text-xs uppercase tracking-wider opacity-80">Speaker</h3>
                <select
                    value={selectedSpeakerId}
                    onChange={(e) => setSelectedSpeakerId(e.target.value)}
                    className="w-full bg-gray-900 border border-cyan-800 rounded p-2 text-xs text-cyan-100 focus:border-cyan-400 outline-none"
                >
                    {speakerDevices.map((device, i) => (
                        <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Speaker ${i + 1}`}
                        </option>
                    ))}
                </select>
            </div>

            {/* Webcam Section */}
            <div className="mb-6">
                <h3 className="text-cyan-400 font-bold mb-2 text-xs uppercase tracking-wider opacity-80">Webcam</h3>
                <select
                    value={selectedWebcamId}
                    onChange={(e) => setSelectedWebcamId(e.target.value)}
                    className="w-full bg-gray-900 border border-cyan-800 rounded p-2 text-xs text-cyan-100 focus:border-cyan-400 outline-none"
                >
                    {webcamDevices.map((device, i) => (
                        <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Camera ${i + 1}`}
                        </option>
                    ))}
                </select>
            </div>

            {/* Cursor Section */}
            <div className="mb-6">
                <div className="flex justify-between mb-2">
                    <h3 className="text-cyan-400 font-bold text-xs uppercase tracking-wider opacity-80">Cursor Sensitivity</h3>
                    <span className="text-xs text-cyan-500">{cursorSensitivity}x</span>
                </div>
                <input
                    type="range"
                    min="1.0"
                    max="5.0"
                    step="0.1"
                    value={cursorSensitivity}
                    onChange={(e) => setCursorSensitivity(parseFloat(e.target.value))}
                    className="w-full accent-cyan-400 cursor-pointer h-1 bg-gray-800 rounded-lg appearance-none"
                />
            </div>

            {/* Gesture Control Section */}
            <div className="mb-6">
                <h3 className="text-cyan-400 font-bold mb-3 text-xs uppercase tracking-wider opacity-80">Gesture Control</h3>
                <div className="flex items-center justify-between text-xs bg-gray-900/50 p-2 rounded border border-cyan-900/30">
                    <span className="text-cyan-100/80">Flip Camera Horizontal</span>
                    <button
                        onClick={toggleCameraFlip}
                        className={`relative w-8 h-4 rounded-full transition-colors duration-200 ${isCameraFlipped ? 'bg-cyan-500/80' : 'bg-gray-700'}`}
                    >
                        <div
                            className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform duration-200 ${isCameraFlipped ? 'translate-x-4' : 'translate-x-0'}`}
                        />
                    </button>
                </div>
            </div>

            {/* Tool Permissions Section */}
            <div className="mb-6">
                <h3 className="text-cyan-400 font-bold mb-3 text-xs uppercase tracking-wider opacity-80">Tool Confirmations</h3>
                <div className="space-y-2 max-h-40 overflow-y-auto pr-2 custom-scrollbar">
                    {TOOLS.map(tool => {
                        const isRequired = permissions[tool.id] !== false; // Default True
                        return (
                            <div key={tool.id} className="flex items-center justify-between text-xs bg-gray-900/50 p-2 rounded border border-cyan-900/30">
                                <span className="text-cyan-100/80">{tool.label}</span>
                                <button
                                    onClick={() => togglePermission(tool.id)}
                                    className={`relative w-8 h-4 rounded-full transition-colors duration-200 ${isRequired ? 'bg-cyan-500/80' : 'bg-gray-700'}`}
                                >
                                    <div
                                        className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform duration-200 ${isRequired ? 'translate-x-4' : 'translate-x-0'}`}
                                    />
                                </button>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Memory Section */}
            <div>
                <h3 className="text-cyan-400 font-bold mb-2 text-xs uppercase tracking-wider opacity-80">Memory Data</h3>
                <div className="flex flex-col gap-2">
                    <label className="text-[10px] text-cyan-500/60 uppercase">Upload Memory Text</label>
                    <input
                        type="file"
                        accept=".txt"
                        onChange={handleFileUpload}
                        className="text-xs text-cyan-100 bg-gray-900 border border-cyan-800 rounded p-2 file:mr-2 file:py-1 file:px-2 file:rounded-full file:border-0 file:text-[10px] file:font-semibold file:bg-cyan-900 file:text-cyan-400 hover:file:bg-cyan-800 cursor-pointer"
                    />
                </div>
            </div>
            </div>
        </div>
    );
};

export default SettingsWindow;
