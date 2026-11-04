"""Read-only local preview: no hidden files, listings, traversal or symlink escape."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
ROOT = Path('/workspace').resolve()
class Preview(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(ROOT), **kwargs)
    def send_head(self):
        parts = Path(unquote(urlsplit(self.path).path)).parts
        target = ROOT.joinpath(*[p for p in parts if p != '/']).resolve()
        if any(p.startswith('.') for p in parts if p != '/') or not target.is_relative_to(ROOT):
            self.send_error(403); return None
        return super().send_head()
    def list_directory(self, path): self.send_error(403); return None
ThreadingHTTPServer(('0.0.0.0', 8000), Preview).serve_forever()
