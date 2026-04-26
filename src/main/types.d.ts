// Vite's `?raw` import suffix returns the file contents as a string.
// electron-vite plumbs through Vite's plugin pipeline for the main and
// preload builds too, so this works the same way in main code.
declare module '*?raw' {
  const content: string;
  export default content;
}
