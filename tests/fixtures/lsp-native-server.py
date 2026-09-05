"""Local LSP 3.17 subset fixture; run only through PUM's native process adapter.

All attempted access targets are disposable test paths or a test-owned loopback
listener. This fixture does not inspect real user configuration or credentials.
"""
import json
import os
import socket
import sys


def receive():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline(1025)
        if not line:
            return None
        if line == b"\r\n":
            break
        key, value = line.decode("ascii").strip().split(":", 1)
        headers[key.lower()] = value.strip()
    length = int(headers["content-length"])
    if not 0 < length <= 256 * 1024:
        raise ValueError("frame limit")
    body = sys.stdin.buffer.read(length)
    if len(body) != length:
        raise ValueError("incomplete frame")
    return json.loads(body)


def reply(request, result):
    body = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body)
    sys.stdout.buffer.flush()


def denied(operation):
    try:
        operation()
    except OSError:
        return True
    return False


def write_project():
    with open("must-not-exist", "x", encoding="utf-8") as output:
        output.write("harmless test mutation")


def read_config():
    with open(sys.argv[1], "rb") as source:
        source.read(1)


def network():
    with socket.create_connection(("127.0.0.1", int(sys.argv[2])), timeout=0.5):
        pass


initialized = False
document = None
pulled = False
shutdown = False
while True:
    request = receive()
    if request is None:
        break
    method = request["method"]
    if method == "initialize":
        reply(request, {"capabilities": {
            "positionEncoding": "utf-16",
            "textDocumentSync": {"openClose": True, "change": 1},
            "diagnosticProvider": {"interFileDependencies": False, "workspaceDiagnostics": False},
        }})
    elif method == "initialized":
        initialized = True
    elif method == "textDocument/didOpen":
        assert initialized and document is None
        document = request["params"]["textDocument"]
        assert document["languageId"] == "python"
    elif method == "textDocument/didChange":
        change = request["params"]
        assert document and document["uri"] == change["textDocument"]["uri"]
        assert len(change["contentChanges"]) == 1 and "range" not in change["contentChanges"][0]
        document.update(version=change["textDocument"]["version"], text=change["contentChanges"][0]["text"])
    elif method == "textDocument/diagnostic":
        assert initialized and document and not pulled
        assert request["params"]["textDocument"]["uri"] == document["uri"]
        with open("example.py", encoding="utf-8") as source:
            synchronized = document["text"] == source.read()
        checks = {
            "projectWriteDenied": denied(write_project),
            "configReadDenied": denied(read_config),
            "networkDenied": denied(network),
            "networkNamespaceIsolated": os.readlink("/proc/self/ns/net") != sys.argv[3],
            "environmentFiltered": "PUM_LSP_NATIVE_TEST_SECRET" not in os.environ,
            "credentialsAbsent": not any(key in os.environ for key in (
                "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS")),
            "fullDocumentSynchronized": synchronized,
        }
        reply(request, {"kind": "full", "items": [{
            "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}},
            "severity": 3,
            "message": json.dumps(checks, sort_keys=True),
        }]})
        pulled = True
    elif method == "textDocument/didClose":
        assert document and request["params"]["textDocument"]["uri"] == document["uri"]
        document = None
    elif method == "shutdown":
        shutdown = True
        reply(request, None)
    elif method == "exit":
        sys.exit(0 if shutdown else 1)
    else:
        raise ValueError("unsupported fixture request")
