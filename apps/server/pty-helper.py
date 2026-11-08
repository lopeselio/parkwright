"""Run a command in a pseudo-terminal of a given size, copying bytes between it and our stdin/stdout.

    python3 pty-helper.py <cols> <rows> <program> [args...]

Used by the local-only Claude terminal (apps/server/src/claude.ts) so `claude` gets a real TTY without
native Node modules. Stdin may be a pipe (unlike BSD `script`, which needs a terminal on stdin).
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def main():
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[3:]
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(argv[0], argv)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)
    stdin, stdout = sys.stdin.fileno(), sys.stdout.fileno()
    open_in = True
    while True:
        fds = [fd] + ([stdin] if open_in else [])
        try:
            ready, _, _ = select.select(fds, [], [])
        except InterruptedError:
            continue
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                break
            os.write(stdout, data)
        if open_in and stdin in ready:
            data = os.read(stdin, 65536)
            if not data:
                open_in = False
                os.kill(pid, signal.SIGHUP)
            else:
                os.write(fd, data)
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)


if __name__ == "__main__":
    main()
