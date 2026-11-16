export const UI_THEMES = [
  {
    id: 'tr-classic',
    label: 'TR CLASSIC',
    accent: '#f26a3d',
    accentSecondary: '#ffc15b',
    accentTertiary: '#57d6c3',
    glow: 'rgba(242, 106, 61, 0.22)',
    background: '#121516',
    surface: '#1b2021',
    raised: '#282c2d',
    panel: '#101617',
    border: '#56534d',
    text: '#f4f1e8',
    muted: '#a39d90',
    grid: '#6f9c8a',
    channelColors: ['#ff704f', '#ffc15b', '#fb9868']
  },
  {
    id: 'cyan-volt',
    label: 'CYAN VOLT',
    accent: '#27d9e8',
    accentSecondary: '#73e6b5',
    accentTertiary: '#719dff',
    glow: 'rgba(39, 217, 232, 0.2)',
    background: '#0c141b',
    surface: '#111d27',
    raised: '#1a2a36',
    panel: '#09131b',
    border: '#34505c',
    text: '#e9f8fb',
    muted: '#93aeb8',
    grid: '#3c8b91',
    channelColors: ['#27d9e8', '#73e6b5', '#719dff']
  },
  {
    id: 'violet-grid',
    label: 'VIOLET GRID',
    accent: '#b78cff',
    accentSecondary: '#f27bd3',
    accentTertiary: '#69b7ff',
    glow: 'rgba(183, 140, 255, 0.22)',
    background: '#12101b',
    surface: '#1b1728',
    raised: '#282039',
    panel: '#100e1a',
    border: '#55466e',
    text: '#f5efff',
    muted: '#aa9dbd',
    grid: '#7a64a1',
    channelColors: ['#b78cff', '#f27bd3', '#69b7ff']
  }
];

export function getUiTheme(id) {
  return UI_THEMES.find((theme) => theme.id === id) || UI_THEMES[0];
}
