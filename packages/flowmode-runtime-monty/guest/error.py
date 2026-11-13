import sandbox as files
from sandbox import read_file as read

async def main():
    try:
        await files.read_file(path="missing.txt")
    except FileNotFoundError as error:
        return [str(error), await read("a.txt")]
