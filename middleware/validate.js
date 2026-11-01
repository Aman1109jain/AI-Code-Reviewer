'use strict';
const { z } = require('zod');
const { HttpError } = require('./errors');

// Validates req.body / req.params / req.query with a zod schema. Unknown keys are
// rejected (mass-assignment protection) and the parsed, typed value replaces the raw
// input, so handlers only ever see data that passed validation.
function validate(schemas) {
  return (req, res, next) => {
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] === undefined ? {} : req[part]);
      if (!result.success) {
        const details = result.error.issues.slice(0, 10).map((i) => ({ field: i.path.join('.'), message: i.message }));
        const first = details[0];
        return next(new HttpError(400, first && first.field ? `${first.field}: ${first.message}` : 'The request is not valid.', { details }));
      }
      Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true, enumerable: true });
    }
    return next();
  };
}

const idParam = z.object({ id: z.string().regex(/^\d{1,9}$/, 'must be a positive number').transform(Number) }).strict();

module.exports = { validate, idParam, z };
