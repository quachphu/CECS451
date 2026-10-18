import sys
from pathlib import Path

# Lets tests and scripts import `ml.*` from the repository root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
