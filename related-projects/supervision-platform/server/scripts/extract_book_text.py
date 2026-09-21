#!/usr/bin/env python3
"""Extract plain text from a PDF for the knowledge-base pipeline.

Usage: python3 extract_book_text.py <file.pdf>
Prints extracted text to stdout. Prefers pdfminer.six and falls back to pypdf;
exits non-zero with a readable message on stderr when neither can parse the file.
"""
import sys


def extract_with_pdfminer(path):
    from pdfminer.high_level import extract_text
    return extract_text(path) or ""


def extract_with_pypdf(path):
    from pypdf import PdfReader
    reader = PdfReader(path)
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def main():
    if len(sys.argv) != 2:
        print("usage: extract_book_text.py <file.pdf>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    errors = []
    for extractor in (extract_with_pdfminer, extract_with_pypdf):
        try:
            text = extractor(path)
            sys.stdout.write(text)
            return 0
        except Exception as exc:  # noqa: BLE001 - report and try the next backend
            errors.append(f"{extractor.__name__}: {exc}")
    print("; ".join(errors), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
