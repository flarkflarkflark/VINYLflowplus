import os
import re

def replace_in_file(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
    except UnicodeDecodeError:
        return False

    original_content = content

    # Pre-process some specific URLs first
    content = content.replace("github.com/flarkflarkflark/VINYLflow+", "github.com/flarkflarkflark/VINYLflow+")
    content = content.replace("github.com/flarkflarkflark/VINYLflow+", "github.com/flarkflarkflark/VINYLflow+")
    
    # Avoid replacing the domain name if possible, but let's change app name occurrences
    # We will use regex to avoid double +'s
    content = re.sub(r'VINYLflow+(?!\+)', 'VINYLflow+', content)
    content = re.sub(r'VINYLflow+(?!\+)(?![\w.-])', 'VINYLflow+', content) # avoid VINYLflow+.app if possible, actually let's just replace VINYLflow+ to VINYLflow+ except in URLs if we can.
    
    # Simple replace with careful lookahead for + to avoid duplicates
    content = re.sub(r'VINYLflow+(?!\+)', 'VINYLflow+', content)
    
    # Replace lowercase vinylflow+ to vinylflow+ where it's a standalone word or command, 
    # but not inside vinylflow.app
    content = re.sub(r'vinylflow+(?!\+)(?!\.app)(?!\.com)', 'vinylflow+', content)
    
    # Fix any accidental double ++
    content = content.replace("VINYLflow+", "VINYLflow+")
    content = content.replace("vinylflow+", "vinylflow+")

    if content != original_content:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        return True
    return False

if __name__ == "__main__":
    count = 0
    for root, dirs, files in os.walk("."):
        if any(ignored in root for ignored in [".git", "venv", "__pycache__", "output", "temp_uploads"]):
            continue
        for file in files:
            if file.endswith((".py", ".md", ".html", ".js", ".txt", ".yml", ".spec", ".example", ".json")):
                filepath = os.path.join(root, file)
                if replace_in_file(filepath):
                    count += 1
                    print(f"Updated: {filepath}")
    print(f"Total files updated: {count}")
