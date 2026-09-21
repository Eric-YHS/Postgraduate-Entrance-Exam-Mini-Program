"""Minimal compatibility layer for the removed Python ``cgi`` module.

The API only uses ``FieldStorage`` for browser multipart file uploads. Keeping
this small local module lets the existing upload handler run on Python 3.13+
without requiring a system-level package installation.
"""

from __future__ import annotations

import io
from email.parser import BytesParser
from email.policy import default as email_policy


class _Field:
    def __init__(self, filename: str | None, content: bytes):
        self.filename = filename
        self.file = io.BytesIO(content)


class FieldStorage:
    def __init__(self, fp, headers, environ=None):
        del environ
        content_type = headers.get("Content-Type", "")
        content_length = int(headers.get("Content-Length", "0"))
        if not content_type.lower().startswith("multipart/form-data"):
            raise ValueError("Expected a multipart/form-data upload.")
        if content_length < 0:
            raise ValueError("Invalid upload content length.")

        raw_body = fp.read(content_length)
        message = BytesParser(policy=email_policy).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + raw_body
        )
        self._values = {}
        self._files = {}
        for part in message.iter_parts():
            if part.get_content_disposition() != "form-data":
                continue
            name = part.get_param("name", header="content-disposition")
            if not name:
                continue
            filename = part.get_filename()
            content = part.get_payload(decode=True) or b""
            if filename is None:
                self._values[name] = content.decode(part.get_content_charset() or "utf-8", errors="replace")
            else:
                self._files.setdefault(name, []).append(_Field(filename, content))

    def getfirst(self, key, default=None):
        return self._values.get(key, default)

    def __contains__(self, key):
        return key in self._files

    def __getitem__(self, key):
        fields = self._files[key]
        return fields if len(fields) > 1 else fields[0]
