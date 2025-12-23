/// <reference types="vite/client" />

// Declaration for vite-imagetools imports with query parameters
declare module '*?format=webp&inline' {
  const src: string
  export default src
}

declare module '*?inline' {
  const src: string
  export default src
}

declare module '*?format=webp' {
  const src: string
  export default src
}
