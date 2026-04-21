import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import type { FirmDeployContext } from './context.js';

export interface AuthProps {
  firm: FirmDeployContext;
}

/**
 * Supervisor/admin auth for the dashboard. Cognito user pool with SAML federation
 * so RIAs can wire Okta / Azure AD / Google Workspace.
 *
 * Agents do NOT authenticate through Cognito; they use Secure Enclave keypairs
 * registered at enrollment.
 */
export class Auth extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'SupervisorPool', {
      userPoolName: `archiveglp-${props.firm.firm_id}-supervisors`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: {
        minLength: 14,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.PLUS,
      standardThreatProtectionMode: cognito.StandardThreatProtectionMode.FULL_FUNCTION,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      standardAttributes: {
        email: { required: true, mutable: false },
        fullname: { required: true, mutable: true },
      },
    });

    if (props.firm.saml_metadata_url) {
      new cognito.UserPoolIdentityProviderSaml(this, 'FirmSaml', {
        userPool: this.userPool,
        metadata: cognito.UserPoolIdentityProviderSamlMetadata.url(props.firm.saml_metadata_url),
        name: `${props.firm.firm_id}-idp`,
        idpSignout: true,
      });
    }

    this.userPoolClient = this.userPool.addClient('DashboardClient', {
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
