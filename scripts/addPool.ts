import { toNano, Address, beginCell } from '@ton/core';
import { MasterChef } from '../wrappers/MasterChef';
import { JettonWalletUSDT } from '../wrappers/JettonWallet';
import { NetworkProvider } from '@ton/blueprint';
import { JettonMasterUSDT } from '../wrappers/JettonMaster';
import { loadDeployment } from '../utils/helper';

export async function run(provider: NetworkProvider) {
    const deployment = await loadDeployment();
    const masterchef = provider.open(MasterChef.fromAddress(Address.parse(deployment.MasterChef)));
    const usdt = provider.open(JettonMasterUSDT.fromAddress(Address.parse(deployment.USDT)));
    const masterchefUSDTWalletAddress = await usdt.getGetWalletAddress(masterchef.address);
    const masterchefUSDTWallet = provider.open(JettonWalletUSDT.fromAddress(masterchefUSDTWalletAddress));

    await masterchef.send(
        provider.sender(),
        {
            value: toNano('0.5'),
        },
        {
            $$type: 'AddPool',
            lpTokenAddress: masterchefUSDTWallet.address,
            allocPoint: 5000n,
        },
    );
}
