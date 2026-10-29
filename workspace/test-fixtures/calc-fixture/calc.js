/**
 * Simple calculation utilities.
 */
function add(a, b) {
  // Intentional bug: subtracts instead of adding for demonstration
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
