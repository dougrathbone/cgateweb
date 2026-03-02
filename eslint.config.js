const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.jest
            }
        },
        rules: {
            // Code quality - keep existing structure
            'no-console': 'off', // We use console for structured logging
            'no-unused-vars': ['warn', { 
                'argsIgnorePattern': '^_',
                'varsIgnorePattern': '^_' 
            }],
            'no-undef': 'error',
            'no-unreachable': 'error',
            
            // Style consistency - relaxed to match existing codebase
            'indent': 'off', // Many files use mixed indentation, fix gradually
            'quotes': 'off', // Mixed single/double quotes in codebase
            'semi': ['error', 'always'],
            'comma-dangle': 'off', // Mixed trailing comma usage
            'object-curly-spacing': 'off', // Mixed spacing
            'array-bracket-spacing': 'off', // Mixed spacing
            
            // Best practices - gradually enforce
            'eqeqeq': 'warn',
            'no-var': 'warn',
            'prefer-const': 'warn',
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-prototype-builtins': 'warn',
            'no-case-declarations': 'warn',
            
            // Error handling
            'no-throw-literal': 'error'
        }
    },
    {
        ignores: ['node_modules/', 'coverage/', '*.min.js']
    }
];
