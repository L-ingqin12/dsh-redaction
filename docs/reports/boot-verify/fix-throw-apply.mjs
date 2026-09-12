export const name = 'x-throw-apply'
export function apply() {
  throw new Error('BOOM-APPLY: synthetic plugin threw inside apply()')
}
