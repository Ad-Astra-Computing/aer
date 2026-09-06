/**
 * Changelog entries with a commit link but no "Thanks @user!" credit.
 *
 * The default GitHub formatter thanks the author of every change. On a
 * single-maintainer repository that reads as noise, and it puts a personal
 * handle in a published artifact. The commit link is what makes an entry
 * traceable, so that is what is kept.
 */
const getReleaseLine = async (changeset, _type, options) => {
  const repo = options && options.repo;
  const lines = changeset.summary.split('\n').map((l) => l.trimEnd());
  const first = lines.shift() || '';
  const rest = lines.map((l) => (l ? `  ${l}` : '')).join('\n');
  const link =
    changeset.commit && repo
      ? `[\`${changeset.commit.slice(0, 7)}\`](https://github.com/${repo}/commit/${changeset.commit}) - `
      : '';
  return `\n- ${link}${first}${rest ? `\n${rest}` : ''}`;
};

const getDependencyReleaseLine = async (_changesets, dependenciesUpdated) => {
  if (dependenciesUpdated.length === 0) return '';
  const updated = dependenciesUpdated.map((d) => `  - ${d.name}@${d.newVersion}`);
  return ['', '- Updated dependencies', ...updated].join('\n');
};

module.exports = { default: { getReleaseLine, getDependencyReleaseLine } };
