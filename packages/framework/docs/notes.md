lets continue to explore the rendering engine in package/framework

we need maybe go back and think about what we want to accomplish
my original idea was, the double/triple buffer patterns is really powerful for games and "rendering" in general
as an AI is streaming out tokens, most application will write it to the screen as fast as its coming out of the stream
and as a user that doesnt "feel" good
the other problem is that the output can be renderable content, like markdown, code, mermaid, perhaps an svg, etc
so you potentially can't rendering properly until you can detect that its finished streaming out
this is where the idea of the settler came, an abstraction that can detect when parts of the stream can move on for further rendering
that idea grew into being able to progressively enhance what comes out of the settler, because sometimes you (mermaid for example) you can stream something out as text as its coming out and the progressively enhance it into an image when you know its done
the "buffer" part of it, I thought ok, if it had prev / next states for each thing emitted, then you could maybe add in animations and things
I think its got good ideas in it, but 1. the vocabulary I'm using is a mess (things need better names) 2. my vision might not align right with the reality of what we've currently built
I'm starting to actually think that, what I really want is not just yolo write the incoming stream to the DOM, but rather only ever deal with the double buffer and maybe part of that buffering is that the reveal stuff we're imagining is actually more about how we deal with the "unsettled" "unprocessed" part of the buffer
maybe we should call it a triple buffer
the (raw) stream (the tokens coming out that have not been settled)
the settled stream (a buffer of the raw stream that the settler has emitted)
the renderable stream ( a prev / next double buffer where the next buffer can be changed and swapped to the previous buffer)
id saw MOST of the time react would be dealing with the prev frame of the renderable stream
I think of the settled buffer as a pool of data that the next buffer is "safe" to try and process
its probably best as just a controlled buffer, this is hard to design this part right
because it would be "cool" to be able to do "typing" animations but MOST of the time you probably want to deal with text line by line
ok, like the most likely usecase for this is like building an opencode / claude code type tool where your trying to syntax highlight huge blocks of code coming out without exploding the CPU trying to parse the entire stream on every new token arriving

1. I think we could bolt something onto the "raw" buffer for the special case that we want to animate the way things are "typed" out, this one is super tough, I have a lot of cool ideas but not sure how to support them
2. TBH the simpliest thing is to provide the data "headless" and let the coder decide (most of the time your probably just sticking the prev frame onto the dom)
3. p-much any content-type we can imagine mermaid, svg, Math (latex) for sure
4. line by line when inside a code fence will probably be fine, but I was thinking about throttling this somehow with a raf
5. I starting to thing this is mostly internal, you interface with it by composing the pipeline and through the headless react hook
  probably need to add another use hook into the mix one that is more low level like the useChatSession and one layered on top of that that abstracts a lot of this complexity into just an array of Message[] that users deal with a simplier API most of the time unless they want to dig into the internals with useChatSession
