'use strict';
const { z } = require('zod');

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, '3-32 characters: letters, digits, dot, underscore or hyphen');

const email = z.string().trim().toLowerCase().max(254).pipe(z.email('must be a valid email address'));

const password = z.string().min(1, 'required').max(128, 'too long');
const code6 = z.string().trim().regex(/^\d{6}$/, 'must be the 6-digit code from your authenticator app');
const role = z.enum(['admin', 'superadmin']);

module.exports = {
  login: z.strictObject({ username: z.string().trim().min(1).max(64), password }),
  initialPassword: z.strictObject({ currentPassword: password, newPassword: password }),
  mfaCode: z.strictObject({ code: code6 }),
  mfaVerify: z
    .strictObject({ code: code6.optional(), recoveryCode: z.string().trim().min(8).max(40).optional() })
    .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), { message: 'Send either code or recoveryCode' }),
  updateMe: z
    .strictObject({ username: username.optional(), email: email.optional(), currentPassword: password })
    .refine((v) => v.username || v.email, { message: 'Nothing to change' }),
  changePassword: z.strictObject({ currentPassword: password, newPassword: password }),
  regenCodes: z.strictObject({ currentPassword: password, code: code6 }),
  createUser: z.strictObject({ username, email, role: role.optional() }),
  updateUser: z
    .strictObject({
      username: username.optional(),
      email: email.optional(),
      role: role.optional(),
      isActive: z.boolean().optional(),
      currentPassword: password,
    })
    .refine((v) => v.username || v.email || v.role || v.isActive !== undefined, { message: 'Nothing to change' }),
  reauth: z.strictObject({ currentPassword: password }),
};
