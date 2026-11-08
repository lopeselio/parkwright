"""Run a command in a pseudo-terminal of a given size, copying bytes between it and our stdin/stdout.

    python3 pty-helper.py <cols> <rows> <program> [args...]

Used by the local-only Claude terminal (apps/server/src/claude.ts) so `claude` gets a real TTY without
native Node modules. Stdin may be a pipe (unlike BSD `script`, which needs a terminal on stdin).
Input to the pty is buffered and written only when writable, so a large paste can't deadlock it against
the program's output; output is written in full. SIGTERM/SIGHUP hang up the program's process group.
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def write_all(fd, data):
    while data:
        try:
            n = os.write(fd, data)
        except InterruptedError:
            continue
        data = data[n:]


def main():
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[3:]
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        except OSError as e:
            os.write(2, f"could not start {argv[0]}: {e.strerror}\r\n".encode())
        os._exit(127)

    def hang_up(*_):
        for sig in (signal.SIGHUP, signal.SIGTERM):
            try:
                os.killpg(pid, sig)
            except OSError:
                pass

    signal.signal(signal.SIGTERM, lambda *_: (hang_up(), sys.exit(0)))
    signal.signal(signal.SIGHUP, lambda *_: (hang_up(), sys.exit(0)))
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)
    fl = fcntl.fcntl(master, fcntl.F_GETFL)
    fcntl.fcntl(master, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    stdin, stdout = sys.stdin.fileno(), sys.stdout.fileno()
    pending = b""
    open_in = True
    hung = False
    while True:
        # Input ended: hang up only once everything already received has reached the program.
        if not open_in and not pending and not hung:
            hung = True
            hang_up()
        rlist = [master] + ([stdin] if open_in and len(pending) < 1 << 20 else [])
        wlist = [master] if pending else []
        try:
            readable, writable, _ = select.select(rlist, wlist, [])
        except InterruptedError:
            continue
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError as e:
                data = b"" if e.errno in (errno.EIO, errno.EBADF) else b""
            if not data:
                break
            write_all(stdout, data)
        if master in writable and pending:
            try:
                n = os.write(master, pending)
                pending = pending[n:]
            except BlockingIOError:
                pass
        if open_in and stdin in readable:
            data = os.read(stdin, 65536)
            if not data:
                open_in = False
            else:
                pending += data
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)


if __name__ == "__main__":
    main()
