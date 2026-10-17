"""Send an exact checked SHA over a dedicated key with pinned SSH host keys."""
import os
from pathlib import Path
import re
import subprocess
import tempfile


def main():
    sha, host, user = (os.environ[k] for k in ['DEPLOY_SHA', 'VM_HOST', 'VM_USER'])
    if not re.fullmatch(r'[0-9a-f]{40}', sha) or not re.fullmatch(r'[a-zA-Z0-9.-]+', host) or not re.fullmatch(r'[a-zA-Z0-9_-]+', user):
        raise ValueError('Invalid SSH target or SHA')
    with tempfile.TemporaryDirectory() as temporary:
        key, hosts = Path(temporary) / 'key', Path(temporary) / 'known_hosts'
        key.write_text(os.environ['VM_SSH_KEY'].rstrip() + '\n')
        hosts.write_text(os.environ['VM_KNOWN_HOSTS'].rstrip() + '\n')
        key.chmod(0o600)
        hosts.chmod(0o600)
        subprocess.run(['ssh', '-T', '-i', str(key), '-o', 'BatchMode=yes',
                        '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
                        '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30',
                        '-o', 'UserKnownHostsFile=' + str(hosts), user + '@' + host,
                        'deploy ' + sha], check=True, timeout=900)


if __name__ == '__main__':
    try:
        main()
    except (KeyError, ValueError, OSError, subprocess.SubprocessError):
        raise SystemExit('SSH deployment failed; credential values were not printed') from None
