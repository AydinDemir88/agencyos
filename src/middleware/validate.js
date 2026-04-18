/**
 * validate — Zod schema validation middleware factory
 *
 * Usage:
 *   router.post('/login', validate(loginSchema), handler)
 *
 * Validates req.body against a Zod schema.
 * On success, replaces req.body with the parsed (coerced + stripped) output.
 * On failure, returns 400 with field-level errors.
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error   : 'Validation failed',
        details : result.error.flatten().fieldErrors,
      });
    }

    req.body = result.data;
    next();
  };
}

module.exports = validate;
