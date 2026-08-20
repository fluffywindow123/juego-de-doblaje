#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

if [ -f "./venv/bin/python" ]; then
    ./venv/bin/python main.py
else
    python3 main.py
fi
