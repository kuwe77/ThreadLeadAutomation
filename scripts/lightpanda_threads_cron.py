#!/usr/bin/env python3
"""Hermes scheduler entrypoint for standalone Lightpanda Threads finder on this VPS."""
from __future__ import annotations
import runpy
from pathlib import Path

TARGET = Path('/root/.hermes/lightpanda-threads/scripts/lightpanda_threads_cron.py')
runpy.run_path(str(TARGET), run_name='__main__')
