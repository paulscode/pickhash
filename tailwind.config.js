/**
 * Tailwind theme for the Pickhash dashboard.
 * Dark-only: a deep navy structure with a fire/ember accent.
 * Compiled to a static stylesheet at image build time — never at runtime, never via CDN.
 */
module.exports = {
  // Scan HTML and app.js. app.js MUST be listed: classes used only from JS would
  // otherwise be purged out of the compiled stylesheet.
  content: [
    './app/frontend/**/*.html',
    './app/frontend/app.js',
  ],
  theme: {
    extend: {
      colors: {
        navy: {
          950: '#0a0e27', // page background
          900: '#141b34', // cards / header
          800: '#1e2849', // inputs
          700: '#283764', // borders
          600: '#3d4f7c', // hover borders / scrollbar hover
        },
        neon: {
          ember: '#ff7a1a',  // primary accent: CTAs, links, active states, chart primary
          flame: '#ffb347',  // secondary chart shades / gradients
          yellow: '#ffbe0b', // balances, active-tab underline
          green: '#06ffa5',  // success / healthy / funds cleared
          pink: '#ff006e',   // error / danger / offline
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
}
