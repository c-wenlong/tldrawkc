// The two places a single box around the words would be wrong, each with a
// line that touches no word and a control that does.
//
// A left-aligned label whose second line is much shorter than its first. Two
// strokes rise from under the box and stop in the middle of the second line:
// `beside` to the right of "short", where there is nothing, and `through`
// into the word itself.
helpers.box('ragged', 'a long first line of words\nshort', { x: 0, y: 0, w: 360, h: 64, align: 'start' })
const box = helpers.describe().shapes.find((shape) => shape.id === 'shape:ragged')
const middle = box.y + box.h / 2
helpers.line('beside', box.x + 200, box.y + box.h + 30, box.x + 200, middle + 15)
helpers.line('through', box.x + 30, box.y + box.h + 30, box.x + 30, middle + 15)

// A caption with a fixed wrap width far wider than its words. `wide` runs
// down through the empty end of it; `struck` through the words.
helpers.text('caption', 'a caption', { x: 0, y: 200, w: 400 })
helpers.line('wide', 300, 180, 300, 250)
helpers.line('struck', 30, 180, 30, 250)
// A heading, a blank line and a subheading. `gap` runs across the blank row,
// which holds no words.
helpers.box('spaced', 'heading\n\nsubheading', { x: 600, y: 0, w: 240, h: 64 })
const spaced = helpers.describe().shapes.find((shape) => shape.id === 'shape:spaced')
const row = spaced.y + spaced.h / 2
helpers.line('gap', spaced.x - 20, row, spaced.x + spaced.w + 20, row)
return helpers.getLints()
