FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 YANBAN_HOST=0.0.0.0 YANBAN_PORT=8000 YANBAN_LOCAL_TEST_MODE=0
WORKDIR /app

# Copy only runtime application files; secrets, data and internal documents are
# excluded by .dockerignore and are mounted separately at runtime.
COPY server.py requirements.txt PROMPT_SPEC.md SCHOOL_SUBJECT_PROFILE_SPEC.md SUBJECT_PROMPT_CATALOG.json ./
COPY student.html teacher.html subject_directory.js ./
COPY assets ./assets

RUN pip install --no-cache-dir -r requirements.txt \
    && mkdir -p /app/data/uploads \
    && addgroup --system yanban \
    && adduser --system --ingroup yanban yanban \
    && chown -R yanban:yanban /app

USER yanban
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD python -c "from urllib.request import urlopen; urlopen('http://127.0.0.1:8000/api/health', timeout=3)"
CMD ["python", "server.py"]
