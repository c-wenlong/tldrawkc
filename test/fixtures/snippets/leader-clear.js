// The same milestone drawn the way the fix message says: the leader starts at
// the box's edge as tldraw reports it once the label is set. Two more lines
// run where a line may run, inside the outline but clear of the words: one
// down the box's left padding and one across its bottom padding.
const y = 300
helpers.line('axis', 40, y, 460, y, { head: 'end' })
helpers.box('t2017', '2017: The Transformer', { x: 110, y: 120, w: 180, h: 56 })
helpers.stub('tick', 200, y - 12, 0, 24)
const box = helpers.describe().shapes.find((shape) => shape.id === 'shape:t2017')
helpers.line('lead', 200, box.y + box.h, 200, y - 12, { dash: 'dashed' })
helpers.line('left-margin', box.x + 8, box.y + 4, box.x + 8, box.y + box.h - 4, { dash: 'dotted' })
helpers.line('bottom-margin', box.x + 4, box.y + box.h - 8, box.x + box.w - 4, box.y + box.h - 8, { dash: 'dotted' })
return helpers.getLints()
