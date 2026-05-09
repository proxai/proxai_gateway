import packageJson from '../../../package.json' with { type: 'json' };

export const PACKAGE_NAME: string = packageJson.name;
export const PACKAGE_VERSION: string = packageJson.version;
export const PACKAGE_DESCRIPTION: string = packageJson.description;
export const GATEWAY_USER_AGENT = `${packageJson.name} ${packageJson.version}` as const;
