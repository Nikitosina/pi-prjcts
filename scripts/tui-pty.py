import base64
import codecs
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios

import pyte

master, slave = pty.openpty()
rows, columns = 42, 140
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
process = subprocess.Popen(sys.argv[2:], cwd=sys.argv[1], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
screen = pyte.Screen(columns, rows)
stream = pyte.Stream(screen)
decoder = codecs.getincrementaldecoder("utf8")("replace")


def emit(value):
    print(json.dumps(value), flush=True)


try:
    while True:
        ready, _, _ = select.select([master, sys.stdin], [], [], 0.2)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if not data:
                break
            stream.feed(decoder.decode(data))
            emit({"kind": "output", "data": base64.b64encode(data).decode("ascii")})
        if sys.stdin in ready:
            line = sys.stdin.readline()
            if not line:
                break
            command = json.loads(line)
            if command["kind"] == "write":
                os.write(master, command["data"].encode("utf8"))
                emit({"kind": "ack", "id": command["id"]})
            elif command["kind"] == "resize":
                rows, columns = command["rows"], command["columns"]
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
                screen.resize(lines=rows, columns=columns)
                os.kill(process.pid, signal.SIGWINCH)
                emit({"kind": "ack", "id": command["id"]})
            elif command["kind"] == "screen":
                emit({"kind": "screen", "id": command["id"], "lines": screen.display})
            elif command["kind"] == "close":
                break
finally:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    os.close(master)
    emit({"kind": "exit", "code": process.returncode})
