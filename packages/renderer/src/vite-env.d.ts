declare module '*.css' {
  const content: string;
  export default content;
}

// Vite's ?worker suffix bundles a module as a Web Worker constructor.
// See: https://vitejs.dev/guide/features.html#web-workers
declare module '*?worker' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
