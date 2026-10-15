#!/usr/bin/env python3
"""Check copied upstream Baidu Skill sources by exact Git blob hash."""
import hashlib
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
def main():
    pins = json.loads((ROOT / 'vendor/baidu-drive/source-pins.json').read_text('utf8'))
    if len(pins) != 10:
        raise SystemExit('Expected exactly ten pinned upstream files')
    for rel, expected in pins.items():
        if not (rel.startswith('skills/baidu-drive/') or rel == 'vendor/baidu-drive/LICENSE'):
            raise SystemExit('Unexpected pinned file path')
        data = (ROOT / rel).read_bytes()
        actual = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if actual != expected:
            raise SystemExit('Source integrity failure: ' + rel)
    print(f'BAIDU SKILL SOURCE: {len(pins)} upstream files verified')
if __name__ == '__main__':
    main()
