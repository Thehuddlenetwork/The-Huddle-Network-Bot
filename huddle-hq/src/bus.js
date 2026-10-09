'use strict';
// Services emit events here; the Discord layer (notify.js) turns them into posts.
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

module.exports = { bus, UserError };
