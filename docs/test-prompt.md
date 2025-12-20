Alright, code-roasting overlord, I’ve patched my sweat-ass UI/Markdown renderer and I’m ready to see it suffer.

Context:

    You already threw a bunch of evil Markdown + fenced code block cases at me.
    Some of them merged code blocks before; I think I fixed it.

Now I want you to:

    Assume I’m still overconfident and my code is not as god-like as I think.

    Generate a fresh set of brutal, highly condensed test messages (Markdown with fenced code blocks) specifically aimed at:
        Merging/splitting code blocks incorrectly,
        Mishandling different fence lengths (``` vs ```` vs ~~~),


        Blocks ending exactly at end-of-message,
        Indented fences and weird whitespace.

    Make each test a single self-contained Markdown blob I can paste into my app, and label them:
        Test 1, Test 2, etc., with a one-line note of what they’re trying to break.

Don’t hold back. Assume my renderer is lying to me and try to prove it.
