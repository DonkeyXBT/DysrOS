/**
 * Vite resolves these at build time; TypeScript needs to be told they exist.
 * Without this, including .tsx in the typecheck fails on the stylesheet import.
 */
declare module '*.css'
