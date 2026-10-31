// Describes the shape of one finding object used across the app.
// Not enforced by code — just a reference so every producer/consumer agrees.
//
// {
//   filePath: string,
//   severity: 'blocking' | 'warning' | 'nitpick',
//   category: 'security' | 'performance' | 'maintainability' | 'readability',
//   issue: string,
//   suggestion: string
// }
module.exports = {};
