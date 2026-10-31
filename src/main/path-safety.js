const fs = require('fs');
const path = require('path');

function assertNoSymlinkPath(targetPath, {allowMissing = false} = {}) {
    const resolved = path.resolve(targetPath);
    const root = path.parse(resolved).root;
    let current = root;

    for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        let stat;
        try {
            stat = fs.lstatSync(current);
        } catch (error) {
            if (allowMissing && error.code === 'ENOENT') return resolved;
            throw error;
        }
        if (stat.isSymbolicLink()) {
            throw new Error(`Symbolic links and junctions are not allowed: ${current}`);
        }
    }
    return resolved;
}

function assertPathWithinDirectory(directory, targetPath, options) {
    const resolvedDirectory = assertNoSymlinkPath(directory);
    const resolvedTarget = path.resolve(targetPath);
    const relative = path.relative(resolvedDirectory, resolvedTarget);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Path is outside the expected directory: ${resolvedTarget}`);
    }
    assertNoSymlinkPath(resolvedTarget, options);
    return resolvedTarget;
}

module.exports = {assertNoSymlinkPath, assertPathWithinDirectory};
