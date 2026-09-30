// The timeline from self-learn#225, cut down to the one milestone that broke.
// The box is declared 56 tall, its label wraps to two lines, tldraw grows it
// with `growY`, and the dashed leader drawn from the declared bottom (y = 176)
// now starts inside the words. `line` mutes the two arrow rules, so before
// `line-crosses-label` nothing in the pass saw it.
const y = 300
helpers.line('axis', 40, y, 460, y, { head: 'end' })
helpers.box('t2017', '2017: The Transformer', { x: 110, y: 120, w: 180, h: 56 })
helpers.stub('tick', 200, y - 12, 0, 24)
helpers.line('lead', 200, 120 + 56, 200, y - 12, { dash: 'dashed' })
return helpers.getLints()
