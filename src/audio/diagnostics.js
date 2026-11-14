const MAX_ENTRIES = 200;
const MAX_MESSAGE_LENGTH = 2000;

const entries = [];
const subscribers = new Set();
let installed = false;
let originalConsoleError = (...args) => console.error(...args);

function formatArgument(value) {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function addDiagnostic(level, message, forwardToNative = true) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message: String(message).slice(0, MAX_MESSAGE_LENGTH)
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  subscribers.forEach((subscriber) => subscriber([...entries]));

  const backend = window.__JUCE__?.backend;
  if (forwardToNative && backend?.emitEvent) {
    try {
      backend.emitEvent('layerforgeDiagnostic', entry);
    } catch (error) {
      originalConsoleError('[LayerForge] Could not forward diagnostics to the native host:', error);
    }
  }
}

export function initializeDiagnostics() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    addDiagnostic('error', args.map(formatArgument).join(' '));
    originalConsoleError(...args);
  };

  window.addEventListener('error', (event) => {
    const location = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
    addDiagnostic('error', `${event.message || 'Uncaught browser error'}${location}`);
  });

  window.addEventListener('unhandledrejection', (event) => {
    addDiagnostic('error', `Unhandled promise rejection: ${formatArgument(event.reason)}`);
  });

  window.__JUCE__?.backend?.addEventListener('layerforgeNativeDiagnostic', ({ level, message }) => {
    addDiagnostic(level || 'error', message, false);
  });
}

export function subscribeDiagnostics(subscriber) {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function getDiagnostics() {
  return [...entries];
}

export function createDiagnosticsReport() {
  const isNative = Boolean(window.__JUCE__);
  const lines = [
    'LayerForge diagnostics',
    `Generated: ${new Date().toISOString()}`,
    `Host: ${isNative ? 'JUCE VST3/AU' : 'Browser'}`,
    `User agent: ${navigator.userAgent}`,
    ...(isNative ? ['Native log: ~/Library/Logs/LayerForge/LayerForge.log'] : []),
    '',
    entries.length ? 'Events:' : 'No frontend errors captured.',
    ...entries.map(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
  ];
  return lines.join('\n');
}
