import {
    Canceled,
    Chains,
    Checksum256,
    LoginContext,
    LogoutContext,
    PermissionLevel,
    ResolvedSigningRequest,
    Serializer,
    SigningRequest,
    TransactContext,
    Transaction,
    WalletPluginLoginResponse,
    WalletPluginSignResponse,
} from '@wharfkit/session'

import {Api, JsonRpc} from 'eosjs'
import {ScatterAccount, ScatterEOS, ScatterIdentity, ScatterJS} from 'scatter-ts'

export async function getScatter(context): Promise<{scatter: any; connector: any}> {
    // register scatter plugins
    ScatterJS.plugins(new ScatterEOS())

    // Setup network
    const url = new URL(context.chain.url)
    const protocol = url.protocol.replace(':', '') === 'https' ? 'https' : 'http'
    const network = ScatterJS.Network.fromJson({
        blockchain: context.chain.name,
        chainId: String(context.chain.id),
        host: url.hostname,
        port: url.port ? Number(url.port) : protocol === 'https' ? 443 : 80,
        protocol,
    })

    // Ensure connected
    const connected: boolean = await ScatterJS.connect(context.appName, {network})
    if (!connected) {
        throw new Error('Unable to connect with Scatter wallet')
    }

    // Establish connector
    const rpc = new JsonRpc(network.fullhost())
    rpc.getRequiredKeys = async () => [] // Hacky way to get around getRequiredKeys
    const connector = ScatterJS.eos(network, Api, {rpc})

    return {
        scatter: ScatterJS,
        connector,
    }
}

export async function handleLogin(context: LoginContext): Promise<WalletPluginLoginResponse> {
    if (!context.ui) {
        throw new Error('No UI available')
    }

    // Retrieve translation helper from the UI, passing the app ID
    // const t = context.ui.getTranslate(this.id)

    const {scatter} = await getScatter(context)

    // login
    const scatterIdentity: ScatterIdentity = await scatter.login()
    if (!scatterIdentity || !scatterIdentity.accounts) {
        throw new Error('Unable to retrieve account from Scatter')
    }
    const account: ScatterAccount = scatterIdentity.accounts[0]

    let chainId: string
    if (account.chainId) {
        chainId = account.chainId
    } else if (
        account.blockchain &&
        Object.keys(Chains).includes(account.blockchain.toUpperCase())
    ) {
        chainId = Chains[account.blockchain.toUpperCase()].id
    } else {
        throw new Error('Unknown chain')
    }

    return {
        chain: Checksum256.from(chainId),
        permissionLevel: PermissionLevel.from(`${account.name}@${account.authority}`),
    }
}

export async function handleLogout(context: LogoutContext): Promise<void> {
    if (context.session === undefined) {
        throw new Error('Unknown session')
    }
    const {scatter} = await getScatter({appName: context.appName, chain: context.session.chain})
    await scatter.logout()
}

export async function handleSignatureRequest(
    resolved: ResolvedSigningRequest,
    context: TransactContext
): Promise<WalletPluginSignResponse> {
    if (!context.ui) {
        throw new Error('No UI available')
    }

    // Retrieve translation helper from the UI, passing the app ID
    // const t = context.ui.getTranslate(this.id)

    // Get the connector from Scatter
    const {scatter, connector} = await getScatter(context)

    const currentIdentity: ScatterIdentity = await scatter.checkLogin()
    if (!currentIdentity || !currentIdentity.accounts) {
        throw new Error('Please login first')
    }

    // Encode the resolved transaction
    const encoded = Serializer.encode({object: resolved.transaction})

    // So eosjs can decode it in its own format
    const decoded = await connector.deserializeTransactionWithActions(encoded.array)

    // Call transact on the connector
    const response = await connector.transact(decoded, {
        broadcast: false,
    })

    if (!response.serializedTransaction) {
        throw new Canceled('User Canceled request')
    }

    // Get the response back (since the wallet may have modified the transaction)
    const modified = Serializer.decode({
        data: response.serializedTransaction,
        type: Transaction,
    })

    // Create the new request and resolve it
    const modifiedRequest = await SigningRequest.create(
        {
            transaction: modified,
        },
        context.esrOptions
    )
    const abis = await modifiedRequest.fetchAbis(context.abiCache)
    const modifiedResolved = modifiedRequest.resolve(abis, context.permissionLevel)

    // Return the modified request and the signatures from the wallet
    return {
        signatures: response.signatures,
        resolved: modifiedResolved,
    }
}
