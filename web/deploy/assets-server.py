"""Serve a directory as a static host, for the browser suite.

Two things `python3 -m http.server` gets wrong for this page: it sends the wasm
as `application/octet-stream`, which `instantiateStreaming` refuses (the page
still works via a slower buffering fallback, so a bug here hides rather than
fails), and it sends no `Access-Control-Allow-Origin` -- harmless for the
single-origin layout here, but kept so a cross-origin skills fetch or a future
split still works. Both are one line each below.

    python3 deploy/assets-server.py <directory> [port] [--bind HOST]

Prints `ASSETS_PORT=<port>` once listening. `--bind` picks the interface
(default 127.0.0.1). The app shell needs nothing special from this server:
it ships in dist/ with its policy in a <meta> tag (system-v2 §10.3).
"""

import functools
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# The same tree, aliased under a sub-path. The page is built with relative
# URLs (`base: './'`) precisely so it can be deployed under one (GitHub
# Pages); the alias lets the browser suite prove that holds -- notably that
# nothing resolves against the domain root.
SUBPATH = "/nested/site"


class Handler(SimpleHTTPRequestHandler):
    # '*': nothing served here is secret or credentialed -- it is a published
    # bundle plus a public skills repository.
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        SimpleHTTPRequestHandler.end_headers(self)

    def translate_path(self, path):
        if path == SUBPATH or path.startswith(SUBPATH + "/"):
            path = path[len(SUBPATH):] or "/"
        return super().translate_path(path)

    def log_message(self, *args):
        pass


# Without this the wasm arrives as application/octet-stream and
# `instantiateStreaming` refuses it. wasm-bindgen then falls back to buffering
# the whole 1.5 MB, so the page still works and the test still passes -- on a
# path production does not take. nginx has this mapping already.
Handler.extensions_map[".wasm"] = "application/wasm"


def main():
    args = list(sys.argv[1:])
    bind = "127.0.0.1"
    if "--bind" in args:
        at = args.index("--bind")
        try:
            bind = args[at + 1]
        except IndexError:
            sys.exit("--bind wants a host")
        del args[at : at + 2]
    if not args:
        sys.exit("usage: assets-server.py <directory> [port] [--bind HOST]")
    directory = args[0]
    port = int(args[1]) if len(args) > 1 else 0

    handler = functools.partial(Handler, directory=directory)
    # Threaded: a browser opens speculative connections and keeps them idle,
    # and a single-threaded server blocks on the first idle socket it
    # accepts -- every later request queues behind it until the browser
    # gives up. Seen as an app window whose frame never navigated, ~90 tests
    # into the suite, once enough idle sockets had piled up.
    server = ThreadingHTTPServer((bind, port), handler)
    server.daemon_threads = True
    print("ASSETS_PORT=%d" % server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
