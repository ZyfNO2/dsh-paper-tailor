"""Optional, host-scoped literature Q&A. Documents are admitted by the Host."""
import asyncio
import json
import sys
from paperqa import Docs


async def main():
    data = json.load(sys.stdin)
    if not 0 < len(data['paths']) <= 25 or len(data['question']) > 4000:
        raise ValueError('Bounded document scope and question required')
    docs = Docs()
    for filename in data['paths']:
        await docs.aadd(filename)
    answer = await docs.aquery(data['question'])
    print(answer.model_dump_json())


asyncio.run(main())
