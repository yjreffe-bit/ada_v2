import json
import urllib.error
import urllib.request


class HttpResult:
    def __init__(self, status, headers, body):
        raw_headers = dict(headers or {})
        self.status = status
        self.headers = {str(key).lower(): value for key, value in raw_headers.items()}
        self.body = body or b""

    def json(self):
        if not self.body:
            return {}
        return json.loads(self.body.decode("utf-8"))

    def text(self):
        return self.body.decode("utf-8", errors="replace")


def http_request(method, url, headers=None, body=None, timeout=120):
    """Perform one HTTP request and return the response, including error bodies."""
    request = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return HttpResult(response.status, response.headers, response.read())
    except urllib.error.HTTPError as exc:
        return HttpResult(exc.code, exc.headers, exc.read())
