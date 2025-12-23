import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Home,
  Menu,
  Network,
  SquareFunction,
  StickyNote,
  Sparkles,
  X,
} from 'lucide-react'
import tanstackLogo from '@/assets/tanstack-word-logo-white.svg'

export default function Header() {
  const [isOpen, setIsOpen] = useState(false)
  const [groupedExpanded, setGroupedExpanded] = useState<
    Record<string, boolean>
  >({})

  const toggleGroup = (group: string) => {
    setGroupedExpanded((prev) => ({
      ...prev,
      [group]: !prev[group],
    }))
  }

  return (
    <>
      <header className="p-4 flex items-center bg-gray-800 text-white shadow-lg">
        <button
          onClick={() => setIsOpen(true)}
          className="p-2 hover:bg-gray-700 rounded-lg transition-colors"
          aria-label="Open menu"
        >
          <Menu size={24} />
        </button>
        <h1 className="ml-4 text-xl font-semibold">
          <Link to="/">
            <img
              src={tanstackLogo}
              alt="TanStack Logo"
              className="h-10"
            />
          </Link>
        </h1>
      </header>

      <aside
        className={`fixed top-0 left-0 h-full w-80 bg-gray-900 text-white shadow-2xl z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${isOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-xl font-bold">Navigation</h2>
          <button
            onClick={() => setIsOpen(false)}
            className="p-2 hover:bg-gray-800 rounded-lg transition-colors"
            aria-label="Close menu"
          >
            <X size={24} />
          </button>
        </div>

        <nav className="flex-1 p-4 overflow-y-auto">
          <Link
            to="/"
            onClick={() => setIsOpen(false)}
            className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-800 transition-colors mb-2"
            activeProps={{
              className:
                'flex items-center gap-3 p-3 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-2',
            }}
          >
            <Home size={20} />
            <span className="font-medium">Home</span>
          </Link>


          {/* Effection Demos Group */}
          <div className="flex flex-row justify-between">
            <div
              onClick={() => toggleGroup('EffectionDemos')}
              className="flex-1 flex items-center gap-3 p-3 rounded-lg hover:bg-gray-800 transition-colors mb-2 cursor-pointer"
            >
              <Sparkles size={20} />
              <span className="font-medium">Effection Demos</span>
            </div>
            <button
              className="p-2 hover:bg-gray-800 rounded-lg transition-colors"
              onClick={() => toggleGroup('EffectionDemos')}
            >
              {groupedExpanded.EffectionDemos ? (
                <ChevronDown size={20} />
              ) : (
                <ChevronRight size={20} />
              )}
            </button>
          </div>
          {groupedExpanded.EffectionDemos && (
            <div className="flex flex-col ml-4 border-l border-gray-700 pl-2">
              <Link
                to="/demo/effection/chat"
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 transition-colors mb-1 text-sm"
                activeProps={{
                  className:
                    'flex items-center gap-3 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-1 text-sm',
                }}
              >
                <span className="font-medium">Chat</span>
                <span className="text-xs text-gray-500">basic streaming</span>
              </Link>

              <Link
                to="/demo/effection/markdown-client-side"
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 transition-colors mb-1 text-sm"
                activeProps={{
                  className:
                    'flex items-center gap-3 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-1 text-sm',
                }}
              >
                <span className="font-medium">MD Client</span>
                <span className="text-xs text-gray-500">client markdown</span>
              </Link>

              <Link
                to="/demo/effection/markdown-stream-side"
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 transition-colors mb-1 text-sm"
                activeProps={{
                  className:
                    'flex items-center gap-3 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-1 text-sm',
                }}
              >
                <span className="font-medium">MD Stream</span>
                <span className="text-xs text-gray-500">stream markdown</span>
              </Link>

              <Link
                to="/demo/effection/math"
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 transition-colors mb-1 text-sm"
                activeProps={{
                  className:
                    'flex items-center gap-3 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-1 text-sm',
                }}
              >
                <span className="font-medium">Math</span>
                <span className="text-xs text-gray-500">persona + tools</span>
              </Link>

              <Link
                to="/demo/effection/mega"
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 transition-colors mb-1 text-sm"
                activeProps={{
                  className:
                    'flex items-center gap-3 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-1 text-sm',
                }}
              >
                <span className="font-medium">Mega</span>
                <span className="text-xs text-gray-500">progressive</span>
              </Link>

              <Link
                to={"/demo/effection/client-tools" as any}
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 transition-colors mb-1 text-sm"
                activeProps={{
                  className:
                    'flex items-center gap-3 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-1 text-sm',
                }}
              >
                <span className="font-medium">Client Tools</span>
                <span className="text-xs text-gray-500">client execution</span>
              </Link>

              <Link
                to={"/demo/effection/card-game" as any}
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 transition-colors mb-1 text-sm"
                activeProps={{
                  className:
                    'flex items-center gap-3 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-1 text-sm',
                }}
              >
                <span className="font-medium">Card Game</span>
                <span className="text-xs text-gray-500">hybrid tools</span>
              </Link>

              <Link
                to={"/demo/effection/magic-trick" as any}
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 transition-colors mb-1 text-sm"
                activeProps={{
                  className:
                    'flex items-center gap-3 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-1 text-sm',
                }}
              >
                <span className="font-medium">Magic Trick</span>
                <span className="text-xs text-gray-500">isomorphic tools</span>
              </Link>

              <Link
                to={"/demo/effection/twenty-questions" as any}
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 transition-colors mb-1 text-sm"
                activeProps={{
                  className:
                    'flex items-center gap-3 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-1 text-sm',
                }}
              >
                <span className="font-medium">20 Questions</span>
                <span className="text-xs text-gray-500">game demo</span>
              </Link>

              <Link
                to={"/demo/effection/typed-tools" as any}
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 transition-colors mb-1 text-sm"
                activeProps={{
                  className:
                    'flex items-center gap-3 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-1 text-sm',
                }}
              >
                <span className="font-medium">Typed Tools</span>
                <span className="text-xs text-gray-500">type-safe builder</span>
              </Link>

              <Link
                to={"/demo/effection/weather-inline" as any}
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 transition-colors mb-1 text-sm"
                activeProps={{
                  className:
                    'flex items-center gap-3 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-1 text-sm',
                }}
              >
                <span className="font-medium">Weather Inline</span>
                <span className="text-xs text-gray-500">conditional UI</span>
              </Link>
            </div>
          )}

          <Link
            to="/demo/start/server-funcs"
            onClick={() => setIsOpen(false)}
            className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-800 transition-colors mb-2"
            activeProps={{
              className:
                'flex items-center gap-3 p-3 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-2',
            }}
          >
            <SquareFunction size={20} />
            <span className="font-medium">Start - Server Functions</span>
          </Link>

          <Link
            to="/demo/start/api-request"
            onClick={() => setIsOpen(false)}
            className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-800 transition-colors mb-2"
            activeProps={{
              className:
                'flex items-center gap-3 p-3 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-2',
            }}
          >
            <Network size={20} />
            <span className="font-medium">Start - API Request</span>
          </Link>

          <div className="flex flex-row justify-between">
            <Link
              to="/demo/start/ssr"
              onClick={() => setIsOpen(false)}
              className="flex-1 flex items-center gap-3 p-3 rounded-lg hover:bg-gray-800 transition-colors mb-2"
              activeProps={{
                className:
                  'flex-1 flex items-center gap-3 p-3 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-2',
              }}
            >
              <StickyNote size={20} />
              <span className="font-medium">Start - SSR Demos</span>
            </Link>
            <button
              className="p-2 hover:bg-gray-800 rounded-lg transition-colors"
              onClick={() => toggleGroup('StartSSRDemo')}
            >
              {groupedExpanded.StartSSRDemo ? (
                <ChevronDown size={20} />
              ) : (
                <ChevronRight size={20} />
              )}
            </button>
          </div>
          {groupedExpanded.StartSSRDemo && (
            <div className="flex flex-col ml-4 border-l border-gray-700 pl-2">
              <Link
                to="/demo/start/ssr/spa-mode"
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 transition-colors mb-1 text-sm"
                activeProps={{
                  className:
                    'flex items-center gap-3 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-1 text-sm',
                }}
              >
                <span className="font-medium">SPA Mode</span>
              </Link>

              <Link
                to="/demo/start/ssr/full-ssr"
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 transition-colors mb-1 text-sm"
                activeProps={{
                  className:
                    'flex items-center gap-3 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-1 text-sm',
                }}
              >
                <span className="font-medium">Full SSR</span>
              </Link>

              <Link
                to="/demo/start/ssr/data-only"
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 transition-colors mb-1 text-sm"
                activeProps={{
                  className:
                    'flex items-center gap-3 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors mb-1 text-sm',
                }}
              >
                <span className="font-medium">Data Only</span>
              </Link>
            </div>
          )}

          {/* Demo Links End */}
        </nav>
      </aside>

      {/* Overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  )
}
