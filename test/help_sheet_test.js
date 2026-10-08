'use strict';
const assert = require('assert');
const { bind } = require('../h5/public/js/ui/help_sheet');

class Node {
    constructor() {
        this.handlers = {};
        this.attributes = {};
        this.classes = new Set(['hidden']);
        this.focusCount = 0;
        this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
    }
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { this.focusCount++; }
    emit(name, event = {}) { for (const fn of this.handlers[name] || []) fn(event); }
}
const trigger = new Node(), sheet = new Node(), close = new Node(), doc = new Node();
sheet.ownerDocument = doc;
assert.strictEqual(bind(null, sheet, close), null);
assert.strictEqual(bind(trigger, null, close), null);
assert.strictEqual(bind(trigger, sheet, null), null);
const controller = bind(trigger, sheet, close);
assert.strictEqual(bind(trigger, sheet, close), controller);
assert.strictEqual(trigger.handlers.click.length, 1);
assert.strictEqual(doc.handlers.keydown.length, 1);
assert.strictEqual(trigger.attributes['aria-expanded'], 'false');
doc.emit('keydown', { key: 'Escape', preventDefault: () => assert.fail('closed sheet must not intercept keyboard') });
controller.hide();
assert.strictEqual(trigger.focusCount, 0);
trigger.emit('click');
assert(!sheet.classes.has('hidden'));
assert.strictEqual(sheet.attributes['aria-hidden'], 'false');
assert.strictEqual(trigger.attributes['aria-expanded'], 'true');
assert.strictEqual(close.focusCount, 1);
sheet.emit('click', { target: close });
assert(!sheet.classes.has('hidden'), 'inside click must not dismiss');
doc.emit('keydown', { key: 'Enter', preventDefault: () => assert.fail('unrelated key must pass through') });
for (const shiftKey of [false, true]) {
    let prevented = false;
    doc.emit('keydown', { key: 'Tab', shiftKey, preventDefault: () => { prevented = true; } });
    assert(prevented);
}
assert.strictEqual(close.focusCount, 3);
close.emit('click');
assert(sheet.classes.has('hidden'));
assert.strictEqual(sheet.attributes['aria-hidden'], 'true');
assert.strictEqual(trigger.attributes['aria-expanded'], 'false');
assert.strictEqual(trigger.focusCount, 1);
controller.show();
sheet.emit('click', { target: sheet });
assert(sheet.classes.has('hidden'));
controller.show();
let prevented = false;
doc.emit('keydown', { key: 'Escape', preventDefault: () => { prevented = true; } });
assert(prevented);
assert(sheet.classes.has('hidden'));
assert.strictEqual(trigger.focusCount, 3);
controller.hide();
assert.strictEqual(trigger.focusCount, 3, 'repeated close must not steal focus');
console.log('[PASS] help sheet missing nodes, idempotence, click/keyboard dismissal, inside click, focus and aria');
