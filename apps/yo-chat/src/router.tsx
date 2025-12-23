import { createRouter } from '@tanstack/react-router'

// Import the generated route tree
import { routeTree } from './routeTree.gen'
import { getBasePath } from '@tanstack/start-env'

// Create a new router instance
export const getRouter = () => {
  const router = createRouter({
    routeTree,
    basepath: getBasePath(),
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  })

  return router
}
