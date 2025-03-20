const { src, dest } = require('gulp')

function copyAssets() {
    return src([
        'nodes/**/*.{jpg,png,svg}',  // Icons
        'nodes/**/assets/**/*'       // Assets folders
    ]).pipe(dest('dist/nodes'))
}

exports.default = copyAssets
