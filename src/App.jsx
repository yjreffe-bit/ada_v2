import React, { Suspense, lazy, useEffect, useMemo, useState, useRef } from 'react';
import io from 'socket.io-client';

import Visualizer from './components/Visualizer';
import TopAudioBar from './components/TopAudioBar';
import ChatModule from './components/ChatModule';
import ToolsModule from './components/ToolsModule';
import { X, Minus, Printer, Clock, RefreshCw, ShieldAlert } from 'lucide-react';

const CadWindow = lazy(() => import('./components/CadWindow'));
const BrowserWindow = lazy(() => import('./components/BrowserWindow'));
const VideoContentWindow = lazy(() => import('./components/VideoContentWindow'));
const ConfirmationPopup = lazy(() => import('./components/ConfirmationPopup'));
const AuthLock = lazy(() => import('./components/AuthLock'));
const KasaWindow = lazy(() => import('./components/KasaWindow'));
const PrinterWindow = lazy(() => import('./components/PrinterWindow'));
const SettingsWindow = lazy(() => import('./components/SettingsWindow'));



const electronApi = typeof window !== 'undefined' && typeof window.require === 'function'
    ? window.require('electron')
    : null;
const ipcRenderer = electronApi?.ipcRenderer ?? null;

const resolveSocketUrl = () => {
    if (typeof window === 'undefined') {
        return 'http://127.0.0.1:8000';
    }

    const configuredUrl = import.meta.env.VITE_SOCKET_URL;
    if (configuredUrl) {
        return configuredUrl;
    }

    if (window.location.protocol === 'file:') {
        return 'http://127.0.0.1:8000';
    }

    return window.location.origin;
};

const socket = io(resolveSocketUrl(), {
    transports: ['websocket', 'polling'],
    autoConnect: true,
    withCredentials: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000
});

const isLocalBrowserHost = () => {
    if (typeof window === 'undefined') return true;
    return ['localhost', '127.0.0.1'].includes(window.location.hostname);
};

const isExplicitRemoteBrowserMode = () => {
    if (typeof window === 'undefined') return false;

    const params = new URLSearchParams(window.location.search);
    const remoteParam = (params.get('remote') || params.get('remoteAudio') || '').toLowerCase();
    const configuredMode = (import.meta.env.VITE_REMOTE_AUDIO_MODE || '').toLowerCase();

    return ['1', 'true', 'host', 'remote'].includes(remoteParam)
        || ['host', 'remote'].includes(configuredMode);
};

const isSecureMediaContext = () => {
    if (typeof window === 'undefined') return true;
    return window.location.protocol === 'file:' || window.isSecureContext || isLocalBrowserHost();
};

const getMediaErrorMessage = (error, type) => {
    if (!error) {
        return `${type} access is unavailable.`;
    }

    switch (error.name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
            return `${type} permission was denied by the browser.`;
        case 'NotFoundError':
        case 'DevicesNotFoundError':
            return `No ${type.toLowerCase()} device was found.`;
        case 'NotReadableError':
        case 'TrackStartError':
            return `${type} is busy in another app or unavailable.`;
        case 'SecurityError':
            return `${type} requires HTTPS or localhost in mobile browsers.`;
        case 'OverconstrainedError':
            return `The selected ${type.toLowerCase()} device is not available.`;
        default:
            return error.message || `${type} could not be started.`;
    }
};

const LoadingPanel = ({ label = 'Loading panel...' }) => (
    <div className="flex h-full min-h-[8rem] w-full items-center justify-center text-xs uppercase tracking-[0.2em] text-cyan-500/70">
        {label}
    </div>
);

const getViewportState = () => {
    if (typeof window === 'undefined') {
        return {
            width: 1280,
            height: 720,
            isMobileLayout: false,
            isCompactLayout: false
        };
    }

    const width = window.innerWidth;
    const height = window.innerHeight;

    return {
        width,
        height,
        isMobileLayout: width <= 1024,
        isCompactLayout: width <= 480 || height <= 760
    };
};

const clampWithinViewport = (pos, size, options = {}) => {
    const { width, height } = getViewportState();
    const {
        margin = 12,
        topOffset = 60,
        bottomOffset = 12
    } = options;

    return {
        x: Math.max(size.w / 2 + margin, Math.min(width - size.w / 2 - margin, pos.x)),
        y: Math.max(size.h / 2 + margin + topOffset, Math.min(height - size.h / 2 - margin - bottomOffset, pos.y))
    };
};

function App() {
    const [status, setStatus] = useState('Disconnected');
    const [socketConnected, setSocketConnected] = useState(socket.connected); // Track socket connection reactively
    // Auth State
    const [isAuthenticated, setIsAuthenticated] = useState(() => {
        // Optimistically assume authenticated if face auth is NOT enabled
        return localStorage.getItem('face_auth_enabled') !== 'true';
    });

    // Initialize from LocalStorage to prevent flash of UI
    const [isLockScreenVisible, setIsLockScreenVisible] = useState(() => {
        const saved = localStorage.getItem('face_auth_enabled');
        // If saved is 'true', we MUST start locked.
        // If 'false' or null (default off), we start unlocked.
        return saved === 'true';
    });

    // Local state for tracking settings, also init from local storage
    const [faceAuthEnabled, setFaceAuthEnabled] = useState(() => {
        return localStorage.getItem('face_auth_enabled') === 'true';
    });


    const [isConnected, setIsConnected] = useState(true); // Power state DEFAULT ON
    const [isMuted, setIsMuted] = useState(true); // Mic state DEFAULT MUTED
    const [isVideoOn, setIsVideoOn] = useState(false); // Video state
    const [messages, setMessages] = useState([]);
    const [inputValue, setInputValue] = useState('');
    const [cadData, setCadData] = useState(null);
    const [cadThoughts, setCadThoughts] = useState(''); // Streaming AI thoughts
    const [cadRetryInfo, setCadRetryInfo] = useState({ attempt: 1, maxAttempts: 3, error: null }); // Retry status
    const [browserData, setBrowserData] = useState({ image: null, logs: [] });
    // showMemoryPrompt removed - memory is now actively saved to project
    const [confirmationRequest, setConfirmationRequest] = useState(null); // { id, tool, args }
    const [kasaDevices, setKasaDevices] = useState([]);
    const [showKasaWindow, setShowKasaWindow] = useState(false);
    const [showPrinterWindow, setShowPrinterWindow] = useState(false);
    const [showCadWindow, setShowCadWindow] = useState(false);
    const [showBrowserWindow, setShowBrowserWindow] = useState(false);
    const [showVideoStudioWindow, setShowVideoStudioWindow] = useState(false);
    const [videoContentData, setVideoContentData] = useState(null);
    const [videoContentStatus, setVideoContentStatus] = useState('idle');
    const [geminiKeyStatus, setGeminiKeyStatus] = useState(null);

    // Printing workflow status (for top toolbar display)
    const [slicingStatus, setSlicingStatus] = useState({ active: false, percent: 0, message: '' });
    const [activePrintStatus, setActivePrintStatus] = useState(null); // {printer, progress_percent, time_elapsed, state}
    const [printerCount, setPrinterCount] = useState(0); // Count of connected printers
    const [currentTime, setCurrentTime] = useState(new Date()); // Live clock


    // RESTORED STATE
    const [aiAudioData, setAiAudioData] = useState(new Array(64).fill(0));
    const [micAudioData, setMicAudioData] = useState(new Array(32).fill(0));
    const [fps, setFps] = useState(0);

    // Device states - microphones, speakers, webcams
    const [micDevices, setMicDevices] = useState([]);
    const [speakerDevices, setSpeakerDevices] = useState([]);
    const [webcamDevices, setWebcamDevices] = useState([]);

    // Selected device IDs - restored from localStorage
    const [selectedMicId, setSelectedMicId] = useState(() => localStorage.getItem('selectedMicId') || '');
    const [selectedSpeakerId, setSelectedSpeakerId] = useState(() => localStorage.getItem('selectedSpeakerId') || '');
    const [selectedWebcamId, setSelectedWebcamId] = useState(() => localStorage.getItem('selectedWebcamId') || '');
    const [showSettings, setShowSettings] = useState(false);
    const [currentProject, setCurrentProject] = useState('default');
    const [viewport, setViewport] = useState(getViewportState);

    const isMobileLayout = viewport.isMobileLayout;
    const isCompactLayout = viewport.isCompactLayout;
    const isElectron = Boolean(ipcRenderer);
    const isRemoteBrowserClient = !isElectron && isExplicitRemoteBrowserMode();
    const secureMediaAvailable = isElectron || isSecureMediaContext();

    const [connectionIssue, setConnectionIssue] = useState('');
    const [mediaWarning, setMediaWarning] = useState('');
    const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
    const [mediaPermissions, setMediaPermissions] = useState({ audio: false, video: false });

    // Modular Mode State
    const [isModularMode, setIsModularMode] = useState(false);
    const [elementPositions, setElementPositions] = useState({
        video: { x: 40, y: 80 }, // Initial positions (approximate)
        visualizer: { x: window.innerWidth / 2, y: window.innerHeight / 2 - 150 },
        chat: { x: window.innerWidth / 2, y: window.innerHeight / 2 + 100 },
        cad: { x: window.innerWidth / 2 + 300, y: window.innerHeight / 2 },
        browser: { x: window.innerWidth / 2 - 300, y: window.innerHeight / 2 },
        videoContent: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
        kasa: { x: window.innerWidth / 2 + 350, y: window.innerHeight / 2 - 100 },
        printer: { x: window.innerWidth / 2 - 350, y: window.innerHeight / 2 - 100 },
        tools: { x: window.innerWidth / 2, y: window.innerHeight - 100 } // Fixed bottom OFFSET
    });

    const [elementSizes, setElementSizes] = useState({
        visualizer: { w: 550, h: 350 },
        chat: { w: 550, h: 220 },
        tools: { w: 500, h: 80 }, // Approx
        cad: { w: 400, h: 400 },
        browser: { w: 550, h: 380 },
        videoContent: { w: 960, h: 720 },
        video: { w: 320, h: 180 },
        kasa: { w: 300, h: 380 }, // Approx
        printer: { w: 380, h: 380 } // Approx
    });
    const [activeDragElement, setActiveDragElement] = useState(null);

    // Z-Index Stacking Order (last element = highest z-index)
    const [zIndexOrder, setZIndexOrder] = useState([
        'visualizer', 'chat', 'tools', 'video', 'cad', 'browser', 'videoContent', 'kasa', 'printer'
    ]);

    // Hand Control State
    const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
    const [isPinching, setIsPinching] = useState(false);
    const [isHandTrackingEnabled, setIsHandTrackingEnabled] = useState(false); // DEFAULT OFF
    const [cursorSensitivity, setCursorSensitivity] = useState(2.0);
    const [isCameraFlipped, setIsCameraFlipped] = useState(false); // Gesture control camera flip

    // Refs for Loop Access (Avoiding Closure Staleness)
    const isHandTrackingEnabledRef = useRef(false); // DEFAULT OFF
    const cursorSensitivityRef = useRef(2.0);
    const isCameraFlippedRef = useRef(false);
    const handLandmarkerRef = useRef(null);
    const cursorTrailRef = useRef([]); // Stores last N positions for trail
    const [ripples, setRipples] = useState([]); // Visual ripples on click

    // Web Audio Context for Mic Visualization
    const audioContextRef = useRef(null);
    const analyserRef = useRef(null);
    const sourceRef = useRef(null);
    const animationFrameRef = useRef(null);

    // Video Refs
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const transmissionCanvasRef = useRef(null); // Dedicated canvas for resizing payload
    const videoIntervalRef = useRef(null);
    const lastFrameTimeRef = useRef(0);
    const frameCountRef = useRef(0);
    const lastVideoTimeRef = useRef(-1);

    // Ref to track video state for the loop (avoids closure staleness)
    const isVideoOnRef = useRef(false);
    const isModularModeRef = useRef(false);
    const elementPositionsRef = useRef(elementPositions);
    const activeDragElementRef = useRef(null);
    const lastActiveDragElementRef = useRef(null);
    const lastCursorPosRef = useRef({ x: 0, y: 0 });
    const lastWristPosRef = useRef({ x: 0, y: 0 }); // For stable fist gesture tracking
    const handConnectionsRef = useRef([]);

    // Smoothing and Snapping Refs
    const smoothedCursorPosRef = useRef({ x: 0, y: 0 });
    const snapStateRef = useRef({ isSnapped: false, element: null, snapPos: { x: 0, y: 0 } });

    // Mouse Drag Refs
    const dragOffsetRef = useRef({ x: 0, y: 0 });
    const isDraggingRef = useRef(false);

    const connectionBannerMessage = useMemo(() => {
        if (!isOnline) {
            return 'Device is offline. Reconnect to Wi-Fi or mobile data to reach A.D.A.';
        }
        if (connectionIssue) {
            return connectionIssue;
        }
        if (!socketConnected) {
            return 'Trying to reconnect to the A.D.A backend.';
        }
        if (isRemoteBrowserClient) {
            return 'Remote mobile mode is active. Voice uses the host desktop audio path; this phone is acting as the control surface.';
        }
        return '';
    }, [connectionIssue, isOnline, isRemoteBrowserClient, socketConnected]);

    const applyEnumeratedDevices = (devs) => {
        const audioInputs = devs.filter(d => d.kind === 'audioinput');
        const audioOutputs = devs.filter(d => d.kind === 'audiooutput');
        const videoInputs = devs.filter(d => d.kind === 'videoinput');

        setMicDevices(audioInputs);
        setSpeakerDevices(audioOutputs);
        setWebcamDevices(videoInputs);

        const savedMicId = localStorage.getItem('selectedMicId');
        if (savedMicId && audioInputs.some(d => d.deviceId === savedMicId)) {
            setSelectedMicId(savedMicId);
        } else if (audioInputs.length > 0) {
            setSelectedMicId(audioInputs[0].deviceId);
        }

        const savedSpeakerId = localStorage.getItem('selectedSpeakerId');
        if (savedSpeakerId && audioOutputs.some(d => d.deviceId === savedSpeakerId)) {
            setSelectedSpeakerId(savedSpeakerId);
        } else if (audioOutputs.length > 0) {
            setSelectedSpeakerId(audioOutputs[0].deviceId);
        }

        const savedWebcamId = localStorage.getItem('selectedWebcamId');
        if (savedWebcamId && videoInputs.some(d => d.deviceId === savedWebcamId)) {
            setSelectedWebcamId(savedWebcamId);
        } else if (videoInputs.length > 0) {
            setSelectedWebcamId(videoInputs[0].deviceId);
        }
    };

    const refreshMediaDevices = async () => {
        if (!navigator.mediaDevices?.enumerateDevices) {
            setMediaWarning('This browser does not expose media devices.');
            return;
        }

        try {
            const devs = await navigator.mediaDevices.enumerateDevices();
            applyEnumeratedDevices(devs);
        } catch (error) {
            console.error('Failed to enumerate devices:', error);
            setMediaWarning('Unable to read microphone or camera devices in this browser.');
        }
    };

    const requestMediaAccess = async ({ audio = false, video = false } = {}) => {
        if (!navigator.mediaDevices?.getUserMedia) {
            setMediaWarning('This browser does not support microphone or camera capture.');
            return false;
        }

        if (!secureMediaAvailable) {
            setMediaWarning('Microphone and camera access need HTTPS or localhost in mobile browsers.');
            return false;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio,
                video
            });

            stream.getTracks().forEach(track => track.stop());
            setMediaPermissions(prev => ({
                audio: prev.audio || audio,
                video: prev.video || video
            }));
            setMediaWarning('');
            await refreshMediaDevices();
            return true;
        } catch (error) {
            console.error('Media permission request failed:', error);
            setMediaWarning(getMediaErrorMessage(error, video ? 'Camera' : 'Microphone'));
            return false;
        }
    };

    // Update refs when state changes
    useEffect(() => {
        isModularModeRef.current = isModularMode;
        elementPositionsRef.current = elementPositions;
        isHandTrackingEnabledRef.current = isHandTrackingEnabled;
        cursorSensitivityRef.current = cursorSensitivity;
        isCameraFlippedRef.current = isCameraFlipped;
        console.log("[Ref Sync] Camera flipped ref updated to:", isCameraFlipped);
    }, [isModularMode, elementPositions, isHandTrackingEnabled, cursorSensitivity, isCameraFlipped]);

    // Live Clock Update
    useEffect(() => {
        const timer = setInterval(() => {
            setCurrentTime(new Date());
        }, 1000);
        return () => clearInterval(timer);
    }, []);

    // Centering Logic (Startup & Resize)
    useEffect(() => {
        const centerElements = () => {
            const nextViewport = getViewportState();
            const { width, height, isMobileLayout: mobile, isCompactLayout: compact } = nextViewport;
            const topBarHeight = mobile ? 112 : 60;
            const gap = mobile ? 14 : 20;
            const safeWidth = Math.max(280, width - (mobile ? 24 : 0));

            let vizH = 400;
            let chatH = 250;

            if (mobile) {
                vizH = Math.max(180, Math.min(300, height * 0.24));
                chatH = Math.max(190, Math.min(280, height * 0.28));
            } else {
                const totalNeeded = topBarHeight + vizH + gap + chatH + gap + 140;

                if (height < totalNeeded) {
                    const available = height - topBarHeight - 140 - (gap * 2);
                    vizH = available * 0.6;
                    chatH = available * 0.4;
                }
            }

            const popupHeight = Math.min(height - topBarHeight - 28, Math.max(360, height * 0.72));
            const nextSizes = {
                visualizer: { w: mobile ? safeWidth : Math.min(600, width * 0.8), h: vizH },
                chat: { w: mobile ? safeWidth : Math.min(600, width * 0.9), h: chatH },
                tools: { w: mobile ? safeWidth : 500, h: mobile ? (compact ? 144 : 112) : 80 },
                cad: { w: mobile ? Math.min(safeWidth, 720) : 400, h: mobile ? popupHeight : 400 },
                browser: { w: mobile ? Math.min(safeWidth, 720) : 550, h: mobile ? popupHeight : 380 },
                videoContent: { w: mobile ? Math.min(safeWidth, 820) : Math.min(1100, width * 0.82), h: mobile ? Math.min(popupHeight, 760) : Math.min(760, height * 0.82) },
                video: {
                    w: mobile ? Math.min(176, Math.round(safeWidth * 0.42)) : 320,
                    h: mobile ? Math.round(Math.min(176, safeWidth * 0.42) * 9 / 16) : 180
                },
                kasa: { w: mobile ? Math.min(safeWidth, 420) : 300, h: mobile ? Math.min(popupHeight, 560) : 380 },
                printer: { w: mobile ? Math.min(safeWidth, 440) : 380, h: mobile ? Math.min(popupHeight, 560) : 380 }
            };

            const vizY = topBarHeight + (vizH / 2);
            const chatY = topBarHeight + vizH + gap;
            const toolsCenterY = mobile ? height - (compact ? 110 : 92) : height - 100;
            const popupCenter = { x: width / 2, y: topBarHeight + ((height - topBarHeight) / 2) };

            setViewport(nextViewport);
            setElementSizes(prev => ({
                ...prev,
                ...nextSizes
            }));

            setElementPositions(prev => ({
                ...prev,
                visualizer: {
                    x: width / 2,
                    y: vizY
                },
                chat: {
                    x: width / 2,
                    y: chatY
                },
                tools: {
                    x: width / 2,
                    y: toolsCenterY
                },
                cad: clampWithinViewport(prev.cad || popupCenter, nextSizes.cad, { topOffset: topBarHeight, bottomOffset: 20 }),
                browser: clampWithinViewport(prev.browser || popupCenter, nextSizes.browser, { topOffset: topBarHeight, bottomOffset: 20 }),
                videoContent: clampWithinViewport(prev.videoContent || popupCenter, nextSizes.videoContent, { topOffset: topBarHeight, bottomOffset: 20 }),
                kasa: clampWithinViewport(prev.kasa || popupCenter, nextSizes.kasa, { topOffset: topBarHeight, bottomOffset: 20 }),
                printer: clampWithinViewport(prev.printer || popupCenter, nextSizes.printer, { topOffset: topBarHeight, bottomOffset: 20 })
            }));
        };

        // Center on mount
        centerElements();

        // Center on resize
        window.addEventListener('resize', centerElements);
        return () => window.removeEventListener('resize', centerElements);
    }, []);

    // Utility: Clamp position to viewport so component stays fully visible
    const clampToViewport = (pos, size) => {
        return clampWithinViewport(pos, size, {
            margin: isMobileLayout ? 12 : 10,
            topOffset: isMobileLayout ? 112 : 60,
            bottomOffset: isMobileLayout ? 20 : 10
        });
    };

    // Utility: Get z-index for an element based on stacking order
    const getZIndex = (id) => {
        const baseZ = 30; // Above background elements
        const index = zIndexOrder.indexOf(id);
        return baseZ + (index >= 0 ? index : 0);
    };

    // Utility: Bring element to front (highest z-index)
    const bringToFront = (id) => {
        setZIndexOrder(prev => {
            const filtered = prev.filter(el => el !== id);
            return [...filtered, id]; // Move to end = highest z-index
        });
    };

    // Ref to track if model has been auto-connected (prevents duplicate connections)
    const hasAutoConnectedRef = useRef(false);

    // Auto-Connect Model on Start (Only after Auth and devices loaded)
    useEffect(() => {
        // Only auto-connect once: when socket connected, authenticated, and devices loaded
        if (!isRemoteBrowserClient && isConnected && isAuthenticated && socketConnected && micDevices.length > 0 && !hasAutoConnectedRef.current) {
            hasAutoConnectedRef.current = true;

            // Trigger Kasa and Printer Discovery
            socket.emit('discover_kasa');
            socket.emit('discover_printers');

            // Connect to model with small delay for socket stability
            const timer = setTimeout(() => {
                const index = micDevices.findIndex(d => d.deviceId === selectedMicId);
                const queryDevice = micDevices.find(d => d.deviceId === selectedMicId);
                const deviceName = queryDevice ? queryDevice.label : null;
                console.log("Auto-connecting to model with device:", deviceName, "Index:", index);

                setStatus('Connecting...');
                socket.emit('start_audio', {
                    device_index: index >= 0 ? index : null,
                    device_name: deviceName,
                    muted: isMuted
                });
            }, 500);
        }
    }, [isConnected, isAuthenticated, socketConnected, micDevices, selectedMicId, isRemoteBrowserClient]);

    useEffect(() => {
        // Socket IO Setup
        const handleConnect = () => {
            setStatus('Connected');
            setSocketConnected(true);
            setConnectionIssue('');
            socket.emit('get_settings');
        };
        const handleDisconnect = () => {
            setStatus('Disconnected');
            setSocketConnected(false);
            setConnectionIssue('Connection to the backend was lost. Reconnecting...');
        };
        const handleConnectError = (error) => {
            console.error('Socket connect error:', error);
            setSocketConnected(false);
            setConnectionIssue(error?.message ? `Backend unavailable: ${error.message}` : 'Backend unavailable. Check that the server is running on the host machine.');
        };

        socket.on('connect', handleConnect);
        socket.on('disconnect', handleDisconnect);
        socket.on('connect_error', handleConnectError);
        socket.io.on('reconnect_attempt', (attempt) => {
            setConnectionIssue(`Reconnecting to the backend (${attempt})...`);
        });
        socket.io.on('reconnect', () => {
            setConnectionIssue('');
        });
        socket.on('status', (data) => {
            addMessage('System', data.msg);
            // Update status bar based on backend messages
            if (data.msg === 'A.D.A Started') {
                setStatus('Model Connected');
            } else if (data.msg === 'A.D.A Stopped') {
                setStatus('Connected');
            }
        });
        socket.on('audio_data', (data) => {
            setAiAudioData(data.data);
        });
        socket.on('auth_status', (data) => {
            console.log("Auth Status:", data);
            setIsAuthenticated(data.authenticated);
            if (data.authenticated) {
                // If authenticated, hide lock screen with animation (handled by component if visible)
                // But simpler: just hide it
                // Actually, wait for animation if it WAS visible.
                // For now, let's just assume if authenticated -> hide
                // But we want the component to invoke onAnimationComplete.
                // If we are starting up (and face auth disabled), we want it FALSE immediately.
                if (!isLockScreenVisible) {
                    // Do nothing, already hidden
                }
            } else {
                // If NOT authenticated, show lock screen
                setIsLockScreenVisible(true);
            }
        });

        socket.on('settings', (settings) => {
            console.log("[Settings] Received:", settings);
            if (settings && typeof settings.face_auth_enabled !== 'undefined') {
                setFaceAuthEnabled(settings.face_auth_enabled);
                localStorage.setItem('face_auth_enabled', settings.face_auth_enabled);
            }
            if (typeof settings.camera_flipped !== 'undefined') {
                console.log("[Settings] Camera flip set to:", settings.camera_flipped);
                setIsCameraFlipped(settings.camera_flipped);
            }
        });
        socket.on('error', (data) => {
            console.error("Socket Error:", data);
            addMessage('System', `Error: ${data.msg}`);
        });
        socket.on('cad_data', (data) => {
            console.log("Received CAD Data:", data);
            setCadData(data);
            setCadThoughts(''); // Clear thoughts when generation complete
            setShowCadWindow(true); // Open window when data arrives
            // Auto-show the window if it's hidden, clamped to viewport
            if (!elementPositions.cad) {
                const size = { w: 400, h: 400 };
                const clamped = clampToViewport({ x: window.innerWidth / 2 + 150, y: window.innerHeight / 2 }, size);
                setElementPositions(prev => ({
                    ...prev,
                    cad: clamped
                }));
            }
        });
        socket.on('cad_status', (data) => {
            console.log("Received CAD Status:", data);
            // Extract retry info from extended payload
            if (data.attempt) {
                setCadRetryInfo({
                    attempt: data.attempt,
                    maxAttempts: data.max_attempts || 3,
                    error: data.error
                });
            }
            if (data.status === 'generating' || data.status === 'retrying') {
                setCadData({ format: 'loading' });
                setShowCadWindow(true);
                if (data.status === 'generating' && data.attempt === 1) {
                    setCadThoughts(''); // Clear previous thoughts for new generation
                }
                // Auto-show the window, clamped to viewport
                if (!elementPositions.cad) {
                    const size = { w: 400, h: 400 };
                    const clamped = clampToViewport({ x: window.innerWidth / 2 + 150, y: window.innerHeight / 2 }, size);
                    setElementPositions(prev => ({
                        ...prev,
                        cad: clamped
                    }));
                }
            } else if (data.status === 'failed') {
                // Keep loading state but show error
                setCadData({ format: 'loading' });
            }
        });
        socket.on('cad_thought', (data) => {
            // Append streaming thought text
            setCadThoughts(prev => prev + data.text);
        });
        socket.on('browser_frame', (data) => {
            setBrowserData(prev => ({
                image: data.image,
                logs: [...prev.logs, data.log].filter(l => l).slice(-50) // Keep last 50 logs
            }));
            setShowBrowserWindow(true);
            // Auto-show browser window if hidden, clamped to viewport
            if (!elementPositions.browser) {
                const size = { w: 550, h: 380 };
                const clamped = clampToViewport({ x: window.innerWidth / 2 - 200, y: window.innerHeight / 2 }, size);
                setElementPositions(prev => ({
                    ...prev,
                    browser: clamped
                }));
            }
        });
        socket.on('video_content_update', (data) => {
            setVideoContentData(prev => prev ? { ...prev, ...data } : { ...data });
            setVideoContentStatus(data.status || 'idle');
            setShowVideoStudioWindow(true);
            if (!elementPositions.videoContent) {
                const size = elementSizes.videoContent || { w: 960, h: 720 };
                const clamped = clampToViewport({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, size);
                setElementPositions(prev => ({
                    ...prev,
                    videoContent: clamped
                }));
            }
        });
        socket.on('gemini_key_status', (data) => {
            setGeminiKeyStatus(data);
        });

        // Handle streaming transcription
        socket.on('transcription', (data) => {
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];

                // If the last message is from the same sender, append the chunk
                if (lastMsg && lastMsg.sender === data.sender) {
                    // Create a NEW object instead of mutating (prevents React StrictMode duplication)
                    return [
                        ...prev.slice(0, -1),
                        {
                            ...lastMsg,
                            text: lastMsg.text + data.text
                        }
                    ];
                } else {
                    // New message block
                    return [...prev, {
                        sender: data.sender,
                        text: data.text,
                        time: new Date().toLocaleTimeString()
                    }];
                }
            });
        });

        // Handle tool confirmation requests
        socket.on('tool_confirmation_request', (data) => {
            console.log("Received Confirmation Request:", data);
            setConfirmationRequest(data);
        });

        // Handle Print Window Request (from CadWindow)
        socket.on('request_print_window', () => {
            setShowPrinterWindow(true);
            const size = { w: 380, h: 380 };
            const clamped = clampToViewport({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, size);
            setElementPositions(prev => ({
                ...prev,
                printer: clamped
            }));
        });

        // Kasa Devices
        socket.on('kasa_devices', (devices) => {
            console.log("Kasa Devices:", devices);
            setKasaDevices(devices);
        });

        socket.on('kasa_update', (data) => {
            setKasaDevices(prev => prev.map(d => {
                if (d.ip === data.ip) {
                    // Update only fields that are not null/undefined
                    return {
                        ...d,
                        is_on: data.is_on !== null ? data.is_on : d.is_on,
                        brightness: data.brightness !== null ? data.brightness : d.brightness
                    };
                }
                return d;
            }));
        });

        socket.on('project_update', (data) => {
            console.log("Project Update:", data.project);
            setCurrentProject(data.project);
            addMessage('System', `Switched to project: ${data.project}`);
        });

        // Track printer count for toolbar display
        socket.on('printer_list', (list) => {
            console.log('[PRINTERS] Count:', list.length);
            setPrinterCount(list.length);
        });

        // Slicing progress for top toolbar
        socket.on('slicing_progress', (data) => {
            console.log('[SLICING] Progress:', data);
            setSlicingStatus({
                active: data.percent < 100,
                percent: data.percent,
                message: data.message
            });
        });

        // Print status for top toolbar - track active prints
        socket.on('print_status_update', (data) => {
            console.log('[PRINT STATUS]', data);
            // Only show in toolbar if actively printing
            if (data.state && data.state.toLowerCase().includes('print')) {
                setActivePrintStatus({
                    printer: data.printer,
                    progress_percent: data.progress_percent,
                    time_elapsed: data.time_elapsed,
                    state: data.state
                });
            } else if (data.state && (data.state.toLowerCase() === 'idle' || data.state.toLowerCase() === 'standby' || data.state.toLowerCase() === 'complete')) {
                // Clear if print finished or idle
                setActivePrintStatus(null);
            }
        });



        refreshMediaDevices();

        return () => {
            socket.off('connect', handleConnect);
            socket.off('disconnect', handleDisconnect);
            socket.off('connect_error', handleConnectError);
            socket.off('status');
            socket.off('audio_data');
            socket.off('cad_data');
            socket.off('cad_thought');
            socket.off('cad_status');
            socket.off('browser_frame');
            socket.off('video_content_update');
            socket.off('gemini_key_status');
            socket.off('transcription');
            socket.off('tool_confirmation_request');
            socket.off('kasa_devices');
            socket.off('printer_list');
            socket.off('slicing_progress');
            socket.off('print_status_update');
            socket.off('error');

            stopMicVisualizer();
            stopVideo();
        };
    }, []);

    useEffect(() => {
        const handleOnline = () => {
            setIsOnline(true);
            setConnectionIssue('');
            if (!socket.connected) {
                socket.connect();
            }
        };

        const handleOffline = () => {
            setIsOnline(false);
            setConnectionIssue('Device is offline.');
        };

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    useEffect(() => {
        if (!isHandTrackingEnabled || handLandmarkerRef.current || !secureMediaAvailable) {
            return;
        }

        let cancelled = false;

        const initHandLandmarker = async () => {
            try {
                console.log('Initializing HandLandmarker...');
                const response = await fetch('/hand_landmarker.task');
                if (!response.ok) {
                    throw new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);
                }

                const visionModule = await import('@mediapipe/tasks-vision');
                const vision = await visionModule.FilesetResolver.forVisionTasks(
                    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm'
                );

                if (cancelled) return;

                handConnectionsRef.current = visionModule.HandLandmarker.HAND_CONNECTIONS;
                handLandmarkerRef.current = await visionModule.HandLandmarker.createFromOptions(vision, {
                    baseOptions: {
                        modelAssetPath: '/hand_landmarker.task',
                        delegate: isMobileLayout ? 'CPU' : 'GPU'
                    },
                    runningMode: 'VIDEO',
                    numHands: 1
                });
                addMessage('System', 'Hand Tracking Ready');
            } catch (error) {
                console.error('Failed to initialize HandLandmarker:', error);
                setMediaWarning(getMediaErrorMessage(error, 'Camera'));
                addMessage('System', `Hand Tracking Error: ${error.message}`);
            }
        };

        initHandLandmarker();

        return () => {
            cancelled = true;
        };
    }, [isHandTrackingEnabled, isMobileLayout, secureMediaAvailable]);

    // Initial check in case we are already connected (fix race condition)
    useEffect(() => {
        if (socket.connected) {
            setStatus('Connected');
            socket.emit('get_settings');
        }
    }, []);

    // Persist device selections to localStorage when they change
    useEffect(() => {
        if (selectedMicId) {
            localStorage.setItem('selectedMicId', selectedMicId);
            console.log('[Settings] Saved microphone:', selectedMicId);
        }
    }, [selectedMicId]);

    useEffect(() => {
        if (selectedSpeakerId) {
            localStorage.setItem('selectedSpeakerId', selectedSpeakerId);
            console.log('[Settings] Saved speaker:', selectedSpeakerId);
        }
    }, [selectedSpeakerId]);

    useEffect(() => {
        if (selectedWebcamId) {
            localStorage.setItem('selectedWebcamId', selectedWebcamId);
            console.log('[Settings] Saved webcam:', selectedWebcamId);
        }
    }, [selectedWebcamId]);

    // Start/Stop Mic Visualizer
    useEffect(() => {
        if (selectedMicId && !isRemoteBrowserClient && secureMediaAvailable) {
            startMicVisualizer(selectedMicId);
        }
    }, [selectedMicId, isRemoteBrowserClient, secureMediaAvailable]);

    const startMicVisualizer = async (deviceId) => {
        stopMicVisualizer();

        if (!secureMediaAvailable || isRemoteBrowserClient) {
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: deviceId } }
            });

            setMediaPermissions(prev => ({ ...prev, audio: true }));
            setMediaWarning('');

            audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
            analyserRef.current = audioContextRef.current.createAnalyser();
            analyserRef.current.fftSize = 64;

            sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
            sourceRef.current.connect(analyserRef.current);

            const updateMicData = () => {
                if (!analyserRef.current) return;
                const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
                analyserRef.current.getByteFrequencyData(dataArray);
                setMicAudioData(Array.from(dataArray));
                animationFrameRef.current = requestAnimationFrame(updateMicData);
            };

            updateMicData();
        } catch (err) {
            console.error("Error accessing microphone:", err);
            setMediaWarning(getMediaErrorMessage(err, 'Microphone'));
        }
    };

    const stopMicVisualizer = () => {
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        if (sourceRef.current) sourceRef.current.disconnect();
        if (audioContextRef.current) audioContextRef.current.close();
    };

    const startVideo = async () => {
        if (!secureMediaAvailable) {
            setMediaWarning('Camera access needs HTTPS or localhost in mobile browsers.');
            return;
        }

        try {
            // Request 1080p resolution with selected webcam
            const constraints = {
                video: {
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                    aspectRatio: 16 / 9
                }
            };

            // Use selected webcam if available
            if (selectedWebcamId) {
                constraints.video.deviceId = { exact: selectedWebcamId };
            }

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            setMediaPermissions(prev => ({ ...prev, video: true }));
            setMediaWarning('');
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.play();
            }

            // Initialize the transmission canvas
            if (!transmissionCanvasRef.current) {
                transmissionCanvasRef.current = document.createElement('canvas');
                transmissionCanvasRef.current.width = 640;
                transmissionCanvasRef.current.height = 360;
                console.log("Initialized transmission canvas (640x360)");
            }

            setIsVideoOn(true);
            isVideoOnRef.current = true; // Update ref for loop

            console.log("Starting video loop with webcam:", selectedWebcamId || "default");
            requestAnimationFrame(predictWebcam);

        } catch (err) {
            console.error("Error accessing camera:", err);
            setMediaWarning(getMediaErrorMessage(err, 'Camera'));
            addMessage('System', 'Error accessing camera');
        }
    };

    const predictWebcam = () => {
        // Use ref for checking state to avoid closure staleness
        if (!videoRef.current || !canvasRef.current || !isVideoOnRef.current) {
            return;
        }

        // Check if video has valid dimensions to prevent MediaPipe crash
        if (videoRef.current.readyState < 2 || videoRef.current.videoWidth === 0 || videoRef.current.videoHeight === 0) {
            requestAnimationFrame(predictWebcam);
            return;
        }

        // 1. Draw Video to Local Display Canvas (Native Resolution)
        const ctx = canvasRef.current.getContext('2d');

        // Ensure canvas matches video dimensions
        if (canvasRef.current.width !== videoRef.current.videoWidth || canvasRef.current.height !== videoRef.current.videoHeight) {
            canvasRef.current.width = videoRef.current.videoWidth;
            canvasRef.current.height = videoRef.current.videoHeight;
        }

        ctx.drawImage(videoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);

        // 2. Send Frame to Backend (Throttled & Resized)
        // Only send if connected
        if (isConnected) {
            // Simple throttle: every 5th frame roughly
            if (frameCountRef.current % 5 === 0) {

                // Use dedicated transmission canvas for resizing
                const transCanvas = transmissionCanvasRef.current;
                if (transCanvas) {
                    const transCtx = transCanvas.getContext('2d');
                    // Draw resized image
                    transCtx.drawImage(videoRef.current, 0, 0, transCanvas.width, transCanvas.height);

                    // Convert resized image to blob
                    transCanvas.toBlob((blob) => {
                        if (blob) {
                            socket.emit('video_frame', { image: blob });
                        }
                    }, 'image/jpeg', 0.6); // Slightly higher compression for speed
                }
            }
        }


        // 3. Hand Tracking
        let startTimeMs = performance.now();
        // Use Ref for toggle check
        if (isHandTrackingEnabledRef.current && handLandmarkerRef.current && videoRef.current.currentTime !== lastVideoTimeRef.current) {
            lastVideoTimeRef.current = videoRef.current.currentTime;
            const results = handLandmarkerRef.current.detectForVideo(videoRef.current, startTimeMs);

            // Log every 100 frames to confirm loop is running
            if (frameCountRef.current % 100 === 0) {
                console.log("Tracking loop running... Last result:", results.landmarks.length > 0 ? "Hand Found" : "No Hand");
            }

            if (results.landmarks && results.landmarks.length > 0) {
                const landmarks = results.landmarks[0];

                // Log on first detection
                if (cursorPos.x === 0 && cursorPos.y === 0) {
                    console.log("First hand detection!", landmarks);
                }

                // Index Finger Tip (8)
                const indexTip = landmarks[8];
                // Thumb Tip (4)
                const thumbTip = landmarks[4];

                // Map to Screen Coords with Sensitivity Scaling
                // Sensitivity: Map center 50% of camera to 100% of screen.
                const SENSITIVITY = cursorSensitivityRef.current;

                // Apply camera flip if enabled (horizontal mirror)
                const rawX = isCameraFlippedRef.current ? (1 - indexTip.x) : indexTip.x;

                // 1. Normalize and Scale X
                let normX = (rawX - 0.5) * SENSITIVITY + 0.5;
                // Clamp to [0, 1]
                normX = Math.max(0, Math.min(1, normX));

                // 2. Normalize and Scale Y
                let normY = (indexTip.y - 0.5) * SENSITIVITY + 0.5;
                normY = Math.max(0, Math.min(1, normY));

                const targetX = normX * window.innerWidth;
                const targetY = normY * window.innerHeight;

                // 1. Smoothing (Lerp)
                // Factor 0.2 = smooth but responsive. Lower = smoother/slower.
                const lerpFactor = 0.2;
                smoothedCursorPosRef.current.x = smoothedCursorPosRef.current.x + (targetX - smoothedCursorPosRef.current.x) * lerpFactor;
                smoothedCursorPosRef.current.y = smoothedCursorPosRef.current.y + (targetY - smoothedCursorPosRef.current.y) * lerpFactor;

                let finalX = smoothedCursorPosRef.current.x;
                let finalY = smoothedCursorPosRef.current.y;

                // 2. Snap-to-Button Logic
                const SNAP_THRESHOLD = 50; // Pixels to snap
                const UNSNAP_THRESHOLD = 100; // Pixels to unsnap (Hysteresis)

                if (snapStateRef.current.isSnapped) {
                    // Check if we should unsnap
                    const dist = Math.sqrt(
                        Math.pow(finalX - snapStateRef.current.snapPos.x, 2) +
                        Math.pow(finalY - snapStateRef.current.snapPos.y, 2)
                    );

                    if (dist > UNSNAP_THRESHOLD) {
                        // REMOVE HIGHLIGHT
                        if (snapStateRef.current.element) {
                            snapStateRef.current.element.classList.remove('snap-highlight');
                            snapStateRef.current.element.style.boxShadow = '';
                            snapStateRef.current.element.style.backgroundColor = '';
                            snapStateRef.current.element.style.borderColor = '';
                        }

                        snapStateRef.current = { isSnapped: false, element: null, snapPos: { x: 0, y: 0 } };
                    } else {
                        // Stay snapped
                        finalX = snapStateRef.current.snapPos.x;
                        finalY = snapStateRef.current.snapPos.y;
                    }
                } else {
                    // Check if we should snap
                    // Find all interactive elements
                    const targets = Array.from(document.querySelectorAll('button, input, select, .draggable'));
                    let closest = null;
                    let minDist = Infinity;

                    for (const el of targets) {
                        const rect = el.getBoundingClientRect();
                        const centerX = rect.left + rect.width / 2;
                        const centerY = rect.top + rect.height / 2;
                        const dist = Math.sqrt(Math.pow(finalX - centerX, 2) + Math.pow(finalY - centerY, 2));

                        if (dist < minDist) {
                            minDist = dist;
                            closest = { el, centerX, centerY };
                        }
                    }

                    if (closest && minDist < SNAP_THRESHOLD) {
                        snapStateRef.current = {
                            isSnapped: true,
                            element: closest.el,
                            snapPos: { x: closest.centerX, y: closest.centerY }
                        };
                        finalX = closest.centerX;
                        finalY = closest.centerY;

                        // SNAP HIGHLIGHT Logic
                        closest.el.classList.add('snap-highlight');
                        // Add some inline style for the glow if class isn't enough (using imperative for speed)
                        closest.el.style.boxShadow = '0 0 20px rgba(34, 211, 238, 0.6)';
                        closest.el.style.backgroundColor = 'rgba(6, 182, 212, 0.2)';
                        closest.el.style.borderColor = 'rgba(34, 211, 238, 1)';
                    }
                }

                // Update Cursor Loop
                setCursorPos({ x: finalX, y: finalY });

                // Trail Logic: Removed per user request

                // Pinch Detection (Distance between Index and Thumb)
                const distance = Math.sqrt(
                    Math.pow(indexTip.x - thumbTip.x, 2) + Math.pow(indexTip.y - thumbTip.y, 2)
                );

                const isPinchNow = distance < 0.05; // Threshold
                if (isPinchNow && !isPinching) {
                    // Click Triggered
                    console.log("Click triggered at", finalX, finalY);

                    // Ripple Effect: Removed per user request

                    const el = document.elementFromPoint(finalX, finalY);
                    if (el) {
                        // Find closest clickable element (button, input, etc.)
                        const clickable = el.closest('button, input, a, [role="button"]');
                        if (clickable && typeof clickable.click === 'function') {
                            clickable.click();
                        } else if (typeof el.click === 'function') {
                            el.click();
                        }
                    }
                }
                setIsPinching(isPinchNow);

                // Fist Detection for Gesture-Based Dragging (Popup Windows Only)
                // Detects if all fingers are folded (tips closer to wrist than MCPs)
                const isFingerFolded = (tipIdx, mcpIdx) => {
                    const tip = landmarks[tipIdx];
                    const mcp = landmarks[mcpIdx];
                    const wrist = landmarks[0];
                    const distTip = Math.sqrt(Math.pow(tip.x - wrist.x, 2) + Math.pow(tip.y - wrist.y, 2));
                    const distMcp = Math.sqrt(Math.pow(mcp.x - wrist.x, 2) + Math.pow(mcp.y - wrist.y, 2));
                    return distTip < distMcp; // Folded if tip is closer
                };

                const isFist = isFingerFolded(8, 5) && isFingerFolded(12, 9) && isFingerFolded(16, 13) && isFingerFolded(20, 17);

                // Get wrist position in screen coordinates (stable reference for fist gesture)
                const wrist = landmarks[0];
                const wristRawX = isCameraFlippedRef.current ? (1 - wrist.x) : wrist.x;
                const wristNormX = Math.max(0, Math.min(1, (wristRawX - 0.5) * SENSITIVITY + 0.5));
                const wristNormY = Math.max(0, Math.min(1, (wrist.y - 0.5) * SENSITIVITY + 0.5));
                const wristScreenX = wristNormX * window.innerWidth;
                const wristScreenY = wristNormY * window.innerHeight;

                if (isFist) {
                    if (!activeDragElementRef.current) {
                        // Only check popup windows (draggable elements)
                        const draggableElements = ['cad', 'browser', 'videoContent', 'kasa', 'printer'];

                        for (const id of draggableElements) {
                            const el = document.getElementById(id);
                            if (el) {
                                const rect = el.getBoundingClientRect();
                                // Use the cursor position from before fist was made for hit detection
                                if (finalX >= rect.left && finalX <= rect.right && finalY >= rect.top && finalY <= rect.bottom) {
                                    activeDragElementRef.current = id;
                                    bringToFront(id);
                                    // Lock the initial wrist position when starting drag
                                    lastWristPosRef.current = { x: wristScreenX, y: wristScreenY };
                                    break;
                                }
                            }
                        }
                    }

                    if (activeDragElementRef.current) {
                        // Use WRIST movement (not index finger) for stable dragging
                        // The wrist doesn't move when making a fist
                        const dx = wristScreenX - lastWristPosRef.current.x;
                        const dy = wristScreenY - lastWristPosRef.current.y;

                        // Update position only if there's actual movement
                        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                            updateElementPosition(activeDragElementRef.current, dx, dy);
                        }

                        // Update last wrist position
                        lastWristPosRef.current = { x: wristScreenX, y: wristScreenY };
                    }
                } else {
                    activeDragElementRef.current = null;
                }

                // Sync state for visual feedback (only on change)
                if (activeDragElementRef.current !== lastActiveDragElementRef.current) {
                    setActiveDragElement(activeDragElementRef.current);
                    lastActiveDragElementRef.current = activeDragElementRef.current;
                }

                lastCursorPosRef.current = { x: finalX, y: finalY };

                // Draw Skeleton
                drawSkeleton(ctx, landmarks);
            }

        }

        // 4. FPS Calculation
        const now = performance.now();
        frameCountRef.current++;
        if (now - lastFrameTimeRef.current >= 1000) {
            setFps(frameCountRef.current);
            frameCountRef.current = 0;
            lastFrameTimeRef.current = now;
        }

        if (isVideoOnRef.current) {
            requestAnimationFrame(predictWebcam);
        }
    };

    const drawSkeleton = (ctx, landmarks) => {
        ctx.strokeStyle = '#00FFFF';
        ctx.lineWidth = 2;

        // Connections
        const connections = handConnectionsRef.current;
        if (!connections?.length) {
            return;
        }
        for (const connection of connections) {
            const start = landmarks[connection.start];
            const end = landmarks[connection.end];
            ctx.beginPath();
            ctx.moveTo(start.x * canvasRef.current.width, start.y * canvasRef.current.height);
            ctx.lineTo(end.x * canvasRef.current.width, end.y * canvasRef.current.height);
            ctx.stroke();
        }
    };

    const stopVideo = () => {
        if (videoRef.current && videoRef.current.srcObject) {
            videoRef.current.srcObject.getTracks().forEach(track => track.stop());
            videoRef.current.srcObject = null;
        }
        setIsVideoOn(false);
        isVideoOnRef.current = false; // Update ref
        setFps(0);
    };

    const toggleVideo = () => {
        if (isVideoOn) {
            stopVideo();
        } else {
            requestMediaAccess({ video: true }).then((granted) => {
                if (granted) {
                    startVideo();
                }
            });
        }
    };

    const addMessage = (sender, text) => {
        setMessages(prev => [...prev, { sender, text, time: new Date().toLocaleTimeString() }]);
    };

    const togglePower = () => {
        if (isRemoteBrowserClient) {
            setMediaWarning('Remote mobile mode can control windows and devices, but live voice still uses the host desktop audio path.');
            return;
        }

        if (!secureMediaAvailable) {
            setMediaWarning('Microphone access needs HTTPS or localhost in mobile browsers.');
            return;
        }

        if (isConnected) {
            socket.emit('stop_audio');
            setIsConnected(false);
            setIsMuted(false); // Reset mute state
        } else {
            requestMediaAccess({ audio: true }).then((granted) => {
                if (!granted) return;

                const index = micDevices.findIndex(d => d.deviceId === selectedMicId);
                socket.emit('start_audio', { device_index: index >= 0 ? index : null });
                setIsConnected(true);
                setIsMuted(false);
            });
        }
    };

    const toggleMute = () => {
        if (isRemoteBrowserClient) {
            setMediaWarning('Mute control is disabled in remote mobile mode because audio stays on the host desktop path.');
            return;
        }

        if (!isConnected) return; // Can't mute if not connected

        if (isMuted) {
            socket.emit('resume_audio');
            setIsMuted(false);
        } else {
            socket.emit('pause_audio');
            setIsMuted(true);
        }
    };

    const handleSend = (e) => {
        if (e.key === 'Enter' && inputValue.trim()) {
            socket.emit('user_input', { text: inputValue });
            addMessage('You', inputValue);
            setInputValue('');
        }
    };

    const handleMinimize = () => ipcRenderer?.send('window-minimize');
    const handleMaximize = () => ipcRenderer?.send('window-maximize');

    // Close Application - memory is now actively saved to project, no prompt needed
    const handleCloseRequest = () => {
        // Emit shutdown signal to backend for graceful shutdown
        // Use volatile emit with timeout fallback to ensure window closes even if server is unresponsive
        const closeWindow = () => {
            if (ipcRenderer) {
                ipcRenderer.send('window-close');
                return;
            }

            if (typeof window !== 'undefined') {
                window.close();
            }
        };

        if (socket.connected) {
            console.log('[APP] Sending shutdown signal to backend...');
            socket.emit('shutdown', {}, (ack) => {
                // This callback may not be called if server uses os._exit
                console.log('[APP] Shutdown acknowledged');
                closeWindow();
            });
            // Fallback: close after 500ms if ack doesn't come back
            setTimeout(closeWindow, 500);
        } else {
            // Socket not connected, just close
            closeWindow();
        }
    };

    const handleFileUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const textContent = event.target.result;
                // Just send the text content directly
                if (typeof textContent === 'string' && textContent.length > 0) {
                    socket.emit('upload_memory', { memory: textContent });
                    addMessage('System', 'Uploading memory...');
                } else {
                    addMessage('System', 'Empty or invalid memory file');
                }
            } catch (err) {
                console.error("Error reading file:", err);
                addMessage('System', 'Error reading memory file');
            }
        };
        reader.readAsText(file);
    };

    // handleCancelClose removed - no longer using memory prompt

    const handleConfirmTool = () => {
        if (confirmationRequest) {
            socket.emit('confirm_tool', { id: confirmationRequest.id, confirmed: true });
            setConfirmationRequest(null);
        }
    };

    const handleDenyTool = () => {
        if (confirmationRequest) {
            socket.emit('confirm_tool', { id: confirmationRequest.id, confirmed: false });
            setConfirmationRequest(null);
        }
    };

    // Updated Bounds Checking Logic
    const updateElementPosition = (id, dx, dy) => {
        setElementPositions(prev => {
            const currentPos = prev[id];
            const size = elementSizes[id] || { w: 100, h: 100 }; // Fallback
            let newX = currentPos.x + dx;
            let newY = currentPos.y + dy;

            // Bounds Logic
            // Depends on anchor point.
            // Visualizer, Tools, Cad, Browser, Kasa: translate(-50%, -50%) -> Center Anchor
            // Chat: translate(-50%, 0) -> Top-Center Anchor
            // Video: Top-Left Anchor (default div)

            const width = window.innerWidth;
            const height = window.innerHeight;
            const margin = 0; // Strict bounds

            if (id === 'chat') {
                // Anchor: Top-Center (x is center, y is top)
                // X Bounds: size.w/2 <= x <= width - size.w/2
                newX = Math.max(size.w / 2 + margin, Math.min(width - size.w / 2 - margin, newX));
                // Y Bounds: 0 <= y <= height - size.h
                newY = Math.max(margin, Math.min(height - size.h - margin, newY));

            } else if (id === 'video') {
                // Anchor: Top-Left
                newX = Math.max(margin, Math.min(width - size.w - margin, newX));
                newY = Math.max(margin, Math.min(height - size.h - margin, newY));

            } else {
                // Anchor: Center
                newX = Math.max(size.w / 2 + margin, Math.min(width - size.w / 2 - margin, newX));
                newY = Math.max(size.h / 2 + margin, Math.min(height - size.h / 2 - margin, newY));
            }

            return {
                ...prev,
                [id]: {
                    x: newX,
                    y: newY
                }
            };
        });
    };

    // --- MOUSE DRAG HANDLERS ---
    const handleMouseDown = (e, id) => {
        console.log(`[MouseDrag] MouseDown on ${id}`, { target: e.target.tagName });

        // Fixed elements that should never be draggable (even in modular mode)
        const fixedElements = ['visualizer', 'chat', 'video', 'tools'];
        if (fixedElements.includes(id)) {
            console.log(`[MouseDrag] ${id} is a fixed element, not draggable`);
            return;
        }

        // Bring clicked element to front (z-index)
        bringToFront(id);

        // Prevent dragging if interacting with inputs, buttons, or canvas (for 3D controls)
        const tagName = e.target.tagName.toLowerCase();
        if (tagName === 'input' || tagName === 'button' || tagName === 'textarea' || tagName === 'canvas' || e.target.closest('button')) {
            console.log("[MouseDrag] Interaction blocked by interactive element");
            return;
        }

        // Check if clicking on a drag handle section (data-drag-handle attribute)
        const isDragHandle = e.target.closest('[data-drag-handle]');
        if (!isDragHandle && !isModularModeRef.current) {
            // If not clicking a drag handle and modular mode is off, don't drag
            // This allows popup windows to have dedicated drag areas
            console.log("[MouseDrag] Not a drag handle and modular mode off");
            return;
        }

        const elPos = elementPositions[id];
        if (!elPos) return;

        // Calculate offset based on anchor point
        // Most are Center Anchored (x, y is center)
        // Chat is Top-Center Anchored (x is center, y is top)
        // Video is Top-Left Anchored (x is left, y is top)

        // We want: MousePos = ElementPos + Offset
        // So: Offset = MousePos - ElementPos
        dragOffsetRef.current = {
            x: e.clientX - elPos.x,
            y: e.clientY - elPos.y
        };

        setActiveDragElement(id);
        activeDragElementRef.current = id;
        isDraggingRef.current = true;

        window.addEventListener('mousemove', handleMouseDrag);
        window.addEventListener('mouseup', handleMouseUp);
    };

    const handleMouseDrag = (e) => {
        if (!isDraggingRef.current || !activeDragElementRef.current) return;

        const id = activeDragElementRef.current;
        const currentPos = elementPositionsRef.current[id];
        if (!currentPos) return;

        // Target Position = MousePos - Offset
        // But we want delta for updateElementPosition??
        // actually updateElementPosition takes dx, dy.
        // Let's just set the position directly or calculate delta.
        // Since updateElementPosition has bounds logic, let's use it, but we need delta from PREVIOUS position?
        // OR we can refactor updateElementPosition to take absolute.
        // Let's stick to calculating new position and manually updating state with bounds logic inside a setter.

        // Actually, updateElementPosition uses setElementPositions(prev => ...).
        // Let's duplicate bounds logic for mouse drag to be precise or reuse.
        // reusing updateElementPosition requires calculating dx/dy from *current state* which might be lagging in the closure?
        // No, functional update is fine.

        // But for smooth mouse drag, absolute position is better.
        const rawNewX = e.clientX - dragOffsetRef.current.x;
        const rawNewY = e.clientY - dragOffsetRef.current.y;

        setElementPositions(prev => {
            const size = elementSizes[id] || { w: 100, h: 100 }; // Fallback
            let newX = rawNewX;
            let newY = rawNewY;

            const width = window.innerWidth;
            const height = window.innerHeight;
            const margin = 0;

            if (id === 'chat') {
                newX = Math.max(size.w / 2 + margin, Math.min(width - size.w / 2 - margin, newX));
                newY = Math.max(margin, Math.min(height - size.h - margin, newY));
            } else if (id === 'video') {
                newX = Math.max(margin, Math.min(width - size.w - margin, newX));
                newY = Math.max(margin, Math.min(height - size.h - margin, newY));
            } else {
                newX = Math.max(size.w / 2 + margin, Math.min(width - size.w / 2 - margin, newX));
                newY = Math.max(size.h / 2 + margin, Math.min(height - size.h / 2 - margin, newY));
            }

            return {
                ...prev,
                [id]: { x: newX, y: newY }
            };
        });
    };

    const handleMouseUp = () => {
        isDraggingRef.current = false;
        setActiveDragElement(null);
        activeDragElementRef.current = null;
        window.removeEventListener('mousemove', handleMouseDrag);
        window.removeEventListener('mouseup', handleMouseUp);
    };

    // Calculate Average Audio Amplitude for Background Pulse
    const audioAmp = aiAudioData.reduce((a, b) => a + b, 0) / aiAudioData.length / 255;

    const toggleKasaWindow = () => {
        if (!showKasaWindow) {
            // Maybe trigger discover instantly?
            if (kasaDevices.length === 0) socket.emit('discover_kasa');
        }
        setShowKasaWindow(!showKasaWindow);
    };

    const togglePrinterWindow = () => {
        setShowPrinterWindow(!showPrinterWindow);
    };

    const toggleVideoStudioWindow = () => {
        setShowVideoStudioWindow(!showVideoStudioWindow);
    };



    return (
        <div className={`${isMobileLayout ? 'min-h-[100dvh] w-full overflow-x-hidden overflow-y-auto' : 'h-screen w-screen overflow-hidden'} bg-black text-cyan-100 font-mono flex flex-col relative selection:bg-cyan-900 selection:text-white`}>

            {/* --- PREMIUM UI LAYER --- */}

            {/* --- PREMIUM UI LAYER --- */}

            {/* --- PREMIUM UI LAYER --- */}

            {/* Logic: Show AuthLock if we are NOT authenticated AND (Lock Screen is visible OR Auth is Enabled) 
                Actually, simpler: isLockScreenVisible is the source of truth for visibility.
                We set isLockScreenVisible = true via socket if auth is required.
             */}

            {isLockScreenVisible && (
                <Suspense fallback={<LoadingPanel label="Loading auth..." />}>
                    <AuthLock
                        socket={socket}
                        onAuthenticated={() => setIsAuthenticated(true)}
                        onAnimationComplete={() => setIsLockScreenVisible(false)}
                    />
                </Suspense>
            )}

            {/* --- PREMIUM UI LAYER --- */}

            {/* Hand Cursor - Only show if tracking is enabled */}
            {isVideoOn && isHandTrackingEnabled && (
                <div
                    className={`fixed w-6 h-6 border-2 rounded-full pointer-events-none z-[100] transition-transform duration-75 ${isPinching ? 'bg-cyan-400 border-cyan-400 scale-75 shadow-[0_0_15px_rgba(34,211,238,0.8)]' : 'border-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.3)]'}`}
                    style={{
                        left: cursorPos.x,
                        top: cursorPos.y,
                        transform: 'translate(-50%, -50%)'
                    }}
                >
                    {/* Center Dot for precision */}
                    <div className="absolute top-1/2 left-1/2 w-1 h-1 bg-white rounded-full -translate-x-1/2 -translate-y-1/2" />
                </div>
            )}

            {/* Background Grid/Effects - ALIVE BACKGROUND (Fixed: Static opacity) */}
            <div
                className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-gray-900 via-black to-black z-0 pointer-events-none"
                style={{ opacity: 0.6 }}
            ></div>
            <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 z-0 pointer-events-none mix-blend-overlay"></div>

            {/* Ambient Glow (Fixed: Static) */}
            <div
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-cyan-900/10 rounded-full blur-[120px] pointer-events-none"
            />

            {/* Top Bar (Draggable) */}
            <div className={`z-50 flex items-center justify-between ${isMobileLayout ? 'flex-wrap gap-3 px-3 py-3' : 'p-2'} border-b border-cyan-500/20 bg-black/40 backdrop-blur-md select-none sticky top-0`} style={isElectron ? { WebkitAppRegion: 'drag' } : undefined}>
                <div className={`flex items-center ${isMobileLayout ? 'flex-wrap gap-2 pl-0' : 'gap-4 pl-2'} min-w-0`}>
                    <h1 className="text-xl font-bold tracking-[0.2em] text-cyan-400 drop-shadow-[0_0_10px_rgba(34,211,238,0.5)]">
                        A.D.A
                    </h1>
                    <div className="text-[10px] text-cyan-700 border border-cyan-900 px-1 rounded">
                        V2.0.0
                    </div>
                    {/* FPS Counter */}
                    {isVideoOn && (
                        <div className="text-[10px] text-green-500 border border-green-900 px-1 rounded ml-2">
                            FPS: {fps}
                        </div>
                    )}
                    {/* Connected Printers Count */}
                    {printerCount > 0 && (
                        <div className="flex items-center gap-1.5 text-[10px] text-green-400 border border-green-500/30 bg-green-500/10 px-2 py-0.5 rounded ml-2">
                            <Printer size={10} className="text-green-400" />
                            <span>{printerCount} Printer{printerCount !== 1 ? 's' : ''}</span>
                        </div>
                    )}
                    {/* Connected Smart Devices Count */}
                    {kasaDevices.length > 0 && (
                        <div className="flex items-center gap-1.5 text-[10px] text-yellow-400 border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 rounded ml-2">
                            <span>💡</span>
                            <span>{kasaDevices.length} Device{kasaDevices.length !== 1 ? 's' : ''}</span>
                        </div>
                    )}
                    {geminiKeyStatus?.slot && (
                        <div className="flex items-center gap-1.5 text-[10px] text-cyan-300 border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 rounded ml-2">
                            <span>AI</span>
                            <span>Key {geminiKeyStatus.slot}</span>
                            <span className="uppercase opacity-70">{geminiKeyStatus.state}</span>
                        </div>
                    )}
                </div>

                {/* Top Visualizer (User Mic) */}
                <div className={`flex-1 flex ${isMobileLayout ? 'order-3 basis-full justify-start' : 'justify-center mx-4'} min-w-0`}>
                    <div className={`${isMobileLayout ? 'w-full max-w-full overflow-hidden' : ''}`}>
                        <TopAudioBar audioData={micAudioData} />
                    </div>
                </div>

                <div className="flex items-center gap-2 pr-2" style={isElectron ? { WebkitAppRegion: 'no-drag' } : undefined}>
                    {/* Live Clock */}
                    <div className="flex items-center gap-1.5 text-[11px] text-cyan-300/70 font-mono px-2">
                        <Clock size={12} className="text-cyan-500/50" />
                        <span>{currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    {isElectron && (
                        <>
                            <button onClick={handleMinimize} className="p-1 hover:bg-cyan-900/50 rounded text-cyan-500 transition-colors">
                                <Minus size={18} />
                            </button>
                            <button onClick={handleMaximize} className="p-1 hover:bg-cyan-900/50 rounded text-cyan-500 transition-colors">
                                <div className="w-[14px] h-[14px] border-2 border-current rounded-[2px]" />
                            </button>
                            <button onClick={handleCloseRequest} className="p-1 hover:bg-red-900/50 rounded text-red-500 transition-colors">
                                <X size={18} />
                            </button>
                        </>
                    )}
                </div>
            </div>

            {(connectionBannerMessage || mediaWarning || (!secureMediaAvailable && !isElectron)) && (
                <div className="sticky top-[72px] z-[60] px-3 pt-2">
                    <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 rounded-2xl border border-cyan-500/20 bg-slate-950/90 px-3 py-2 text-xs text-cyan-100 shadow-[0_0_20px_rgba(34,211,238,0.08)] backdrop-blur-xl">
                        <ShieldAlert size={14} className="text-cyan-400" />
                        <span className="flex-1 min-w-[14rem]">{mediaWarning || connectionBannerMessage || 'Mobile browser safeguards are active.'}</span>
                        {!socketConnected && (
                            <button
                                onClick={() => socket.connect()}
                                className="inline-flex items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-[11px] uppercase tracking-widest text-cyan-300 transition-colors hover:bg-cyan-500/20"
                            >
                                <RefreshCw size={12} /> Retry
                            </button>
                        )}
                        {!mediaPermissions.audio && secureMediaAvailable && !isRemoteBrowserClient && (
                            <button
                                onClick={() => requestMediaAccess({ audio: true })}
                                className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-[11px] uppercase tracking-widest text-cyan-300 transition-colors hover:bg-cyan-500/20"
                            >
                                Allow Mic
                            </button>
                        )}
                        {!mediaPermissions.video && secureMediaAvailable && (
                            <button
                                onClick={() => requestMediaAccess({ video: true })}
                                className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-[11px] uppercase tracking-widest text-cyan-300 transition-colors hover:bg-cyan-500/20"
                            >
                                Allow Camera
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Main Content */}
            <div className={`flex-1 relative z-10 flex flex-col items-center ${isMobileLayout ? 'justify-start px-3 pt-3 pb-6 gap-3' : 'justify-center'}`}>
                {/* Central Visualizer (AI Audio) */}
                <div
                    id="visualizer"
                    className={`${isMobileLayout ? 'relative w-full max-w-full' : 'absolute'} flex items-center justify-center transition-all duration-200 
                        backdrop-blur-xl bg-black/30 border border-white/10 shadow-2xl overflow-visible
                        ${isModularMode ? (activeDragElement === 'visualizer' ? 'ring-2 ring-green-500 bg-green-500/10' : 'ring-1 ring-yellow-500/30 bg-yellow-500/5') + ' rounded-2xl pointer-events-auto' : 'rounded-2xl pointer-events-none'}
                    `}
                    style={{
                        ...(isMobileLayout ? {
                            width: '100%',
                            maxWidth: `${elementSizes.visualizer.w}px`
                        } : {
                            left: elementPositions.visualizer.x,
                            top: elementPositions.visualizer.y,
                            transform: 'translate(-50%, -50%)',
                            width: elementSizes.visualizer.w
                        }),
                        height: elementSizes.visualizer.h
                    }}
                    onMouseDown={(e) => handleMouseDown(e, 'visualizer')}
                >
                    <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-10 pointer-events-none mix-blend-overlay z-10"></div>
                    <div className="relative z-20">
                        <Visualizer
                            audioData={aiAudioData}
                            isListening={isConnected && !isMuted}
                            intensity={audioAmp}
                            width={elementSizes.visualizer.w}
                            height={elementSizes.visualizer.h}
                        />
                    </div>
                    {isModularMode && <div className={`absolute top-2 right-2 text-xs font-bold tracking-widest z-20 ${activeDragElement === 'visualizer' ? 'text-green-500' : 'text-yellow-500/50'}`}>VISUALIZER</div>}
                </div>

                {/* Video Feed Overlay */}
                {/* Floating Project Label */}
                <div className={`${isMobileLayout ? 'relative top-0 left-0 translate-x-0' : 'absolute top-[70px] left-1/2 -translate-x-1/2'} text-cyan-500 text-xs font-mono tracking-widest pointer-events-none z-50 bg-black/50 px-2 py-1 rounded backdrop-blur-sm border border-cyan-500/20`}>
                    PROJECT: {currentProject?.toUpperCase()}
                </div>

                <div
                    id="video"
                    className={`fixed ${isMobileLayout ? 'top-[calc(env(safe-area-inset-top)+7rem)] right-3' : 'bottom-4 right-4'} transition-all duration-200 
                        ${isVideoOn ? 'opacity-100' : 'opacity-0 pointer-events-none'} 
                        backdrop-blur-md bg-black/40 border border-white/10 shadow-xl rounded-xl
                    `}
                    style={{ zIndex: 20 }}
                >
                    <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-5 pointer-events-none mix-blend-overlay"></div>
                    {/* Compact Display Container (1080p Source) */}
                    <div className="relative border border-cyan-500/30 rounded-lg overflow-hidden shadow-[0_0_20px_rgba(6,182,212,0.1)] aspect-video bg-black/80" style={{ width: `${elementSizes.video.w}px` }}>
                        {/* Hidden Video Element (Source) */}
                        <video ref={videoRef} autoPlay muted className="absolute inset-0 w-full h-full object-cover opacity-0" />

                        <div className="absolute top-2 left-2 text-[10px] text-cyan-400 bg-black/60 backdrop-blur px-2 py-0.5 rounded border border-cyan-500/20 z-10 font-bold tracking-wider">CAM_01</div>

                        {/* Canvas for Displaying Video + Skeleton (Ensures overlap) */}
                        <canvas
                            ref={canvasRef}
                            className="absolute inset-0 w-full h-full opacity-80"
                            style={{ transform: isCameraFlipped ? 'scaleX(-1)' : 'none' }}
                        />
                    </div>
                </div>

                {/* Settings Modal - Moved outside Video so it shows independently */}
                {showSettings && (
                    <Suspense fallback={<LoadingPanel label="Loading settings..." />}>
                        <SettingsWindow
                            socket={socket}
                            micDevices={micDevices}
                            speakerDevices={speakerDevices}
                            webcamDevices={webcamDevices}
                            selectedMicId={selectedMicId}
                            setSelectedMicId={setSelectedMicId}
                            selectedSpeakerId={selectedSpeakerId}
                            setSelectedSpeakerId={setSelectedSpeakerId}
                            selectedWebcamId={selectedWebcamId}
                            setSelectedWebcamId={setSelectedWebcamId}
                            cursorSensitivity={cursorSensitivity}
                            setCursorSensitivity={setCursorSensitivity}
                            isCameraFlipped={isCameraFlipped}
                            setIsCameraFlipped={setIsCameraFlipped}
                            handleFileUpload={handleFileUpload}
                            mobileLayout={isMobileLayout}
                            onClose={() => setShowSettings(false)}
                        />
                    </Suspense>
                )}

                {/* CAD Window Overlay - Moved outside of Video so it can show independently */}
                {showCadWindow && (
                    <div
                        id="cad"
                        className={`${isMobileLayout ? 'fixed' : 'absolute'} flex flex-col transition-all duration-200 
                        backdrop-blur-xl bg-black/40 border border-white/10 shadow-2xl overflow-hidden rounded-2xl
                        ${activeDragElement === 'cad' ? 'ring-2 ring-green-500 bg-green-500/10' : ''}
                    `}
                        style={{
                            ...(isMobileLayout ? {
                                left: '50%',
                                top: 'calc(env(safe-area-inset-top) + 6.5rem)',
                                transform: 'translateX(-50%)',
                                width: `min(calc(100vw - 1.5rem), ${elementSizes.cad.w}px)`,
                                height: `min(calc(100dvh - 8rem - env(safe-area-inset-bottom)), ${elementSizes.cad.h}px)`
                            } : {
                                left: elementPositions.cad?.x || window.innerWidth / 2,
                                top: elementPositions.cad?.y || window.innerHeight / 2,
                                transform: 'translate(-50%, -50%)',
                                width: `${elementSizes.cad.w}px`,
                                height: `${elementSizes.cad.h}px`
                            }),
                            pointerEvents: 'auto',
                            zIndex: getZIndex('cad')
                        }}
                        onMouseDown={(e) => handleMouseDown(e, 'cad')}
                    >
                        {/* Drag Handle Header */}
                        <div
                            data-drag-handle
                            className="h-8 bg-gray-900/80 border-b border-cyan-500/20 flex items-center justify-between px-3 cursor-grab active:cursor-grabbing shrink-0"
                        >
                            <span className="text-xs font-bold tracking-widest text-cyan-500/70">CAD PROTOTYPE</span>
                            <button
                                onClick={() => setShowCadWindow(false)}
                                className="text-gray-400 hover:text-red-400 hover:bg-red-500/20 p-1 rounded transition-colors"
                            >
                                ✕
                            </button>
                        </div>
                        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-10 pointer-events-none mix-blend-overlay z-10"></div>
                        <div className="relative z-20 flex-1 min-h-0">
                            <Suspense fallback={<LoadingPanel label="Loading CAD..." />}>
                                <CadWindow
                                    data={cadData}
                                    thoughts={cadThoughts}
                                    retryInfo={cadRetryInfo}
                                    onClose={() => setShowCadWindow(false)}
                                    socket={socket}
                                    mobileLayout={isMobileLayout}
                                />
                            </Suspense>
                        </div>
                    </div>
                )}


                {/* Browser Window Overlay */}
                {showBrowserWindow && (
                    <div
                        id="browser"
                        className={`${isMobileLayout ? 'fixed' : 'absolute'} flex flex-col transition-all duration-200 
                        backdrop-blur-xl bg-black/40 border border-white/10 shadow-2xl overflow-hidden rounded-lg
                        ${activeDragElement === 'browser' ? 'ring-2 ring-green-500 bg-green-500/10' : ''}
                    `}
                        style={{
                            ...(isMobileLayout ? {
                                left: '50%',
                                top: 'calc(env(safe-area-inset-top) + 6.5rem)',
                                transform: 'translateX(-50%)',
                                width: `min(calc(100vw - 1.5rem), ${elementSizes.browser.w}px)`,
                                height: `min(calc(100dvh - 8rem - env(safe-area-inset-bottom)), ${elementSizes.browser.h}px)`
                            } : {
                                left: elementPositions.browser?.x || window.innerWidth / 2 - 200,
                                top: elementPositions.browser?.y || window.innerHeight / 2,
                                transform: 'translate(-50%, -50%)',
                                width: `${elementSizes.browser.w}px`,
                                height: `${elementSizes.browser.h}px`
                            }),
                            pointerEvents: 'auto',
                            zIndex: getZIndex('browser')
                        }}
                        onMouseDown={(e) => handleMouseDown(e, 'browser')}
                    >
                        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-10 pointer-events-none mix-blend-overlay z-10"></div>
                        <div className="relative z-20 w-full h-full">
                            <Suspense fallback={<LoadingPanel label="Loading browser..." />}>
                                <BrowserWindow
                                    imageSrc={browserData.image}
                                    logs={browserData.logs}
                                    onClose={() => setShowBrowserWindow(false)}
                                    socket={socket}
                                    mobileLayout={isMobileLayout}
                                />
                            </Suspense>
                        </div>
                    </div>
                )}

                {showVideoStudioWindow && (
                    <div
                        id="videoContent"
                        className={`${isMobileLayout ? 'fixed' : 'absolute'} flex flex-col transition-all duration-200 backdrop-blur-xl bg-black/40 border border-white/10 shadow-2xl overflow-hidden rounded-2xl ${activeDragElement === 'videoContent' ? 'ring-2 ring-green-500 bg-green-500/10' : ''}`}
                        style={{
                            ...(isMobileLayout ? {
                                left: '50%',
                                top: 'calc(env(safe-area-inset-top) + 6.5rem)',
                                transform: 'translateX(-50%)',
                                width: `min(calc(100vw - 1.5rem), ${elementSizes.videoContent.w}px)`,
                                height: `min(calc(100dvh - 8rem - env(safe-area-inset-bottom)), ${elementSizes.videoContent.h}px)`
                            } : {
                                left: elementPositions.videoContent?.x || window.innerWidth / 2,
                                top: elementPositions.videoContent?.y || window.innerHeight / 2,
                                transform: 'translate(-50%, -50%)',
                                width: `${elementSizes.videoContent.w}px`,
                                height: `${elementSizes.videoContent.h}px`
                            }),
                            pointerEvents: 'auto',
                            zIndex: getZIndex('videoContent')
                        }}
                        onMouseDown={(e) => handleMouseDown(e, 'videoContent')}
                    >
                        <Suspense fallback={<LoadingPanel label="Loading video studio..." />}>
                            <VideoContentWindow
                                socket={socket}
                                data={videoContentData}
                                status={videoContentStatus}
                                onClose={() => setShowVideoStudioWindow(false)}
                                mobileLayout={isMobileLayout}
                            />
                        </Suspense>
                    </div>
                )}


                {/* Chat Module */}
                <ChatModule
                    messages={messages}
                    inputValue={inputValue}
                    setInputValue={setInputValue}
                    handleSend={handleSend}
                    isModularMode={isModularMode}
                    activeDragElement={activeDragElement}
                    position={elementPositions.chat}
                    width={elementSizes.chat.w}
                    height={elementSizes.chat.h}
                    mobileLayout={isMobileLayout}
                    onMouseDown={(e) => handleMouseDown(e, 'chat')}
                />

                {/* Footer Controls / Tools Module */}
                <div className={`z-20 flex justify-center ${isMobileLayout ? 'w-full pb-2 pointer-events-auto' : 'pb-10 pointer-events-none'}`}>
                    <ToolsModule
                        isConnected={isConnected}
                        isMuted={isMuted}
                        isVideoOn={isVideoOn}
                        isHandTrackingEnabled={isHandTrackingEnabled}
                        showSettings={showSettings}
                        onTogglePower={togglePower}
                        onToggleMute={toggleMute}
                        onToggleVideo={toggleVideo}
                        onToggleSettings={() => setShowSettings(!showSettings)}
                        onToggleHand={() => setIsHandTrackingEnabled(!isHandTrackingEnabled)}
                        onToggleKasa={toggleKasaWindow}
                        showKasaWindow={showKasaWindow}
                        onTogglePrinter={togglePrinterWindow}
                        showPrinterWindow={showPrinterWindow}
                        onToggleCad={() => setShowCadWindow(!showCadWindow)}
                        showCadWindow={showCadWindow}
                        onToggleBrowser={() => setShowBrowserWindow(!showBrowserWindow)}
                        showBrowserWindow={showBrowserWindow}
                        onToggleVideoStudio={toggleVideoStudioWindow}
                        showVideoStudioWindow={showVideoStudioWindow}
                        activeDragElement={activeDragElement}
                        position={elementPositions.tools}
                        mobileLayout={isMobileLayout}
                        onMouseDown={(e) => handleMouseDown(e, 'tools')}
                    />
                </div>

                {/* Kasa Window */}
                {showKasaWindow && (
                    <Suspense fallback={<LoadingPanel label="Loading devices..." />}>
                        <KasaWindow
                            socket={socket}
                            position={elementPositions.kasa}
                            activeDragElement={activeDragElement}
                            setActiveDragElement={setActiveDragElement}
                            devices={kasaDevices}
                            onClose={() => setShowKasaWindow(false)}
                            onMouseDown={(e) => handleMouseDown(e, 'kasa')}
                            zIndex={getZIndex('kasa')}
                            mobileLayout={isMobileLayout}
                        />
                    </Suspense>
                )}

                {/* Printer Window */}
                {showPrinterWindow && (
                    <Suspense fallback={<LoadingPanel label="Loading printers..." />}>
                        <PrinterWindow
                            socket={socket}
                            onClose={() => setShowPrinterWindow(false)}
                            position={elementPositions.printer}
                            onMouseDown={(e) => handleMouseDown(e, 'printer')}
                            activeDragElement={activeDragElement}
                            setActiveDragElement={setActiveDragElement}
                            zIndex={getZIndex('printer')}
                            mobileLayout={isMobileLayout}
                        />
                    </Suspense>
                )}

                {/* Memory Prompt removed - memory is now actively saved to project */}

                {/* Tool Confirmation Modal */}
                <Suspense fallback={null}>
                    <ConfirmationPopup
                        request={confirmationRequest}
                        onConfirm={handleConfirmTool}
                        onDeny={handleDenyTool}
                    />
                </Suspense>
            </div>
        </div>
    );
}

export default App;
