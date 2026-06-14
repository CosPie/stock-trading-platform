from pathlib import Path
import tomllib


LOCK_PATH = Path("third_party/tradingagents/uv.lock")
OUTPUT_PATH = Path("/tmp/tradingagents-constraints.txt")


packages = tomllib.loads(LOCK_PATH.read_text()).get("package", [])
locked = {
    package["name"]: package["version"]
    for package in packages
    if package["name"] != "tradingagents"
}

constraints = "\n".join(f"{name}=={locked[name]}" for name in sorted(locked))
OUTPUT_PATH.write_text(f"{constraints}\n")
