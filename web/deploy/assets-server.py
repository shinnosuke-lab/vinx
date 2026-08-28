"""Serve a directory as a static host, for the browser suite.

Two things `python3 -m http.server` gets wrong for this page: it sends the wasm
as `application/octet-stream`, which `instantiateStreaming` refuses (the page
still works via a slower buffering fallback, so a bug here hides rather than
fails), and it sends no `Access-Control-Allow-Origin` -- harmless for the
single-origin layout here, but kept so a cross-origin skills fetch or a future
split still works. Both are one line each below.

    python3 deploy/assets-server.py <directory> [port]

Prints `ASSETS_PORT=<port>` once listening.
"""

import functools
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


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
    if len(sys.argv) < 2:
        sys.exit("usage: assets-server.py <directory> [port]")
    directory = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 0

    handler = functools.partial(Handler, directory=directory)
    server = HTTPServer(("127.0.0.1", port), handler)
    print("ASSETS_PORT=%d" % server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
